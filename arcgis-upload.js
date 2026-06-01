const axios = require('axios');
const FormData = require('form-data');

const PORTAL   = 'https://www.arcgis.com';
const USERNAME = () => process.env.ARCGIS_USERNAME;

// ===== Token 管理（用账号密码换取用户 Token，有效期 60 分钟）=====
let _tokenCache = null;

async function getToken() {
    if (_tokenCache && Date.now() < _tokenCache.expiresAt) {
        return _tokenCache.token;
    }

    const resp = await axios.post(
        `${PORTAL}/sharing/rest/generateToken`,
        new URLSearchParams({
            username:   USERNAME(),
            password:   process.env.ARCGIS_PASSWORD,
            referer:    'https://www.arcgis.com',
            expiration: '60',
            f:          'json'
        })
    );

    if (resp.data.error) {
        throw new Error(`登录失败: ${resp.data.error.message} (检查 ARCGIS_USERNAME / ARCGIS_PASSWORD)`);
    }

    _tokenCache = {
        token:     resp.data.token,
        expiresAt: Date.now() + 55 * 60 * 1000  // 提前 5 分钟刷新
    };
    return _tokenCache.token;
}

// Step 1: Upload DWG file as ArcGIS Online item（已存在则先删除再上传）
async function addItem(fileName, fileBuffer) {
    const token = await getToken();
    const title = fileName.replace(/\.[^.]+$/, '').replace(/[^\w\s-]/g, '_');

    // 检查是否已存在同名 item，存在则删除
    const existingId = await findExistingItem(title, token);
    if (existingId) {
        console.log(`[ArcGIS] 删除已有 item: ${existingId}`);
        await deleteItem(existingId, token);
    }

    const form = new FormData();
    form.append('file', fileBuffer, {
        filename: fileName,
        contentType: 'application/octet-stream'
    });
    form.append('title', title);
    form.append('type', 'CAD Drawing');
    form.append('token', token);
    form.append('f', 'json');

    const resp = await axios.post(
        `${PORTAL}/sharing/rest/content/users/${USERNAME()}/addItem`,
        form,
        { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity }
    );

    if (!resp.data.success) {
        const msg = resp.data.error?.message || JSON.stringify(resp.data);
        throw new Error(`addItem failed: ${msg}`);
    }

    console.log(`[ArcGIS] item 上传成功: ${resp.data.id}`);
    return resp.data.id;
}

async function findExistingItem(title, token) {
    const resp = await axios.get(`${PORTAL}/sharing/rest/search`, {
        params: {
            q: `title:"${title}" AND owner:${USERNAME()} AND type:"CAD Drawing"`,
            token,
            f: 'json',
            num: 1
        }
    });
    return resp.data.results?.[0]?.id || null;
}

async function deleteItem(itemId, token) {
    await axios.post(
        `${PORTAL}/sharing/rest/content/users/${USERNAME()}/items/${itemId}/delete`,
        new URLSearchParams({ token, f: 'json' })
    );
}

// Step 2: Publish as hosted feature layer (CAD feature service)
async function publishItem(itemId, fileName) {
    const token = await getToken();
    const name  = fileName
        .replace(/\.[^.]+$/, '')
        .replace(/[^\w]/g, '_')
        .slice(0, 50);

    const publishParams = JSON.stringify({
        name,
        targetSR: { wkid: 4326 },
        maxRecordCount: 2000,
        capabilities: 'Query'
    });

    const resp = await axios.post(
        `${PORTAL}/sharing/rest/content/users/${USERNAME()}/items/${itemId}/publish`,
        new URLSearchParams({
            publishParameters: publishParams,
            token,
            f: 'json'
        })
    );

    // 打出完整响应，帮助排查格式问题
    console.log('[ArcGIS publish raw]:', JSON.stringify(resp.data, null, 2));

    if (resp.data.error) {
        throw new Error(`publish failed: ${resp.data.error.message}`);
    }

    const services = resp.data.services || [];

    if (services.length === 0) {
        // 返回 itemId 供调试，同时抛出详细错误
        throw new Error(
            `ArcGIS 未返回 service（itemId=${itemId}）。` +
            `请前往 arcgis.com/home/content.html 手动发布，然后使用下方"手动输入 URL"功能。\n` +
            `完整响应: ${JSON.stringify(resp.data)}`
        );
    }

    const svc = services[0];

    // 兼容同步发布（无 jobId，serviceurl 直接可用）和异步发布
    if (svc.serviceurl && !svc.jobId) {
        // 同步完成，直接返回 URL
        return { jobId: null, serviceItemId: svc.serviceItemId, serviceUrl: svc.serviceurl };
    }

    return { jobId: svc.jobId, serviceItemId: svc.serviceItemId, serviceUrl: null };
}

// Step 3: Poll publish job status
async function getJobStatus(jobId) {
    const token = await getToken();
    const resp  = await axios.get(
        `${PORTAL}/sharing/rest/content/users/${USERNAME()}/items/${jobId}/status`,
        { params: { token, f: 'json' } }
    );
    // { status: "completed"|"processing"|"failed", statusMessage, itemId }
    return resp.data;
}

// Step 4: Get the feature service URL once completed
async function getServiceUrl(serviceItemId) {
    const token = await getToken();
    const resp  = await axios.get(
        `${PORTAL}/sharing/rest/content/items/${serviceItemId}`,
        { params: { token, f: 'json' } }
    );
    if (!resp.data.url) throw new Error('Service URL not found');
    return resp.data.url;
}

module.exports = { addItem, publishItem, getJobStatus, getServiceUrl };
