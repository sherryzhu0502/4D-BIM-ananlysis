const axios = require('axios');

const BASE = 'https://developer.api.autodesk.com';
// APS 要求：只含小写字母、数字、- _ .
const BUCKET_KEY = () =>
    (process.env.APS_BUCKET_KEY || 'construction-viewer-bucket')
        .toLowerCase()
        .replace(/[^a-z0-9\-_.]/g, '-');

let _internalToken = null;
let _viewerToken = null;

// ===== Authentication =====

async function fetchToken(scopes) {
    // APS v2 要求用 Basic Auth，不能把凭据放 body
    const basic = Buffer.from(
        `${process.env.APS_CLIENT_ID}:${process.env.APS_CLIENT_SECRET}`
    ).toString('base64');

    const resp = await axios.post(
        `${BASE}/authentication/v2/token`,
        new URLSearchParams({ grant_type: 'client_credentials', scope: scopes.join(' ') }),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: `Basic ${basic}`
            }
        }
    );
    return { ...resp.data, expiresAt: Date.now() + (resp.data.expires_in - 60) * 1000 };
}

async function getInternalToken() {
    if (!_internalToken || Date.now() >= _internalToken.expiresAt) {
        _internalToken = await fetchToken([
            'data:read', 'data:write', 'data:create',
            'bucket:read', 'bucket:create'
        ]);
    }
    return _internalToken;
}

async function getViewerToken() {
    if (!_viewerToken || Date.now() >= _viewerToken.expiresAt) {
        _viewerToken = await fetchToken(['viewables:read']);
    }
    return _viewerToken;
}

// ===== OSS Bucket =====

async function ensureBucketExists() {
    const { access_token } = await getInternalToken();
    const headers = { Authorization: `Bearer ${access_token}` };

    try {
        await axios.get(`${BASE}/oss/v2/buckets/${BUCKET_KEY()}/details`, { headers });
    } catch (err) {
        if (err.response?.status === 404) {
            await axios.post(
                `${BASE}/oss/v2/buckets`,
                { bucketKey: BUCKET_KEY(), policyKey: 'persistent' },
                {
                    headers: {
                        ...headers,
                        'Content-Type': 'application/json',
                        'x-ads-region': 'US'
                    }
                }
            );
        } else if (err.response?.status !== 409) {
            throw err;
        }
    }
}

// ===== File Upload (Signed S3 URL — 替换废弃的直接 PUT) =====

async function uploadFile(fileName, fileBuffer) {
    await ensureBucketExists();
    const { access_token } = await getInternalToken();
    const encodedKey = encodeURIComponent(fileName);
    const authHeader = { Authorization: `Bearer ${access_token}` };

    // Step 1: 申请 Signed S3 上传 URL
    const signResp = await axios.get(
        `${BASE}/oss/v2/buckets/${BUCKET_KEY()}/objects/${encodedKey}/signeds3upload`,
        { headers: authHeader, params: { minutesExpiration: 60 } }
    );
    const { uploadKey, urls } = signResp.data;

    // Step 2: 直接 PUT 到 S3（无需 APS token）
    await axios.put(urls[0], fileBuffer, {
        headers: { 'Content-Type': 'application/octet-stream' },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
    });

    // Step 3: 通知 APS 上传完成
    const completeResp = await axios.post(
        `${BASE}/oss/v2/buckets/${BUCKET_KEY()}/objects/${encodedKey}/signeds3upload`,
        { uploadKey },
        { headers: { ...authHeader, 'Content-Type': 'application/json' } }
    );
    return completeResp.data;
}

// ===== Model Derivative =====

async function translateFile(urn) {
    const { access_token } = await getInternalToken();
    const resp = await axios.post(
        `${BASE}/modelderivative/v2/designdata/job`,
        {
            input: { urn },
            output: { formats: [{ type: 'svf2', views: ['2d', '3d'] }] }
        },
        {
            headers: {
                Authorization: `Bearer ${access_token}`,
                'Content-Type': 'application/json',
                'x-ads-force': 'true'
            }
        }
    );
    return resp.data;
}

async function getManifest(urn) {
    const { access_token } = await getInternalToken();
    const resp = await axios.get(
        `${BASE}/modelderivative/v2/designdata/${urn}/manifest`,
        { headers: { Authorization: `Bearer ${access_token}` } }
    );
    return resp.data;
}

async function getMetadata(urn) {
    const { access_token } = await getInternalToken();
    const resp = await axios.get(
        `${BASE}/modelderivative/v2/designdata/${urn}/metadata`,
        { headers: { Authorization: `Bearer ${access_token}` } }
    );
    return resp.data;
}

async function getProperties(urn, guid) {
    const { access_token } = await getInternalToken();
    const resp = await axios.get(
        `${BASE}/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties`,
        { headers: { Authorization: `Bearer ${access_token}` } }
    );
    return resp.data;
}

module.exports = {
    getViewerToken,
    uploadFile,
    translateFile,
    getManifest,
    getMetadata,
    getProperties,
    BUCKET_KEY
};
