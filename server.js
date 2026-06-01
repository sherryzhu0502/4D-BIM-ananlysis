require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api',         require('./routes/aps'));      // APS Viewer 路由
app.use('/api/arcgis',  require('./routes/arcgis'));   // ArcGIS 路由

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n  建筑模型坐标查看器: http://localhost:${PORT}\n`);
});
