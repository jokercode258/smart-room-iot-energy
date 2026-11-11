// ============================================================
// CLOUD SERVER
//  - Luồng A: nhận dữ liệu từ Node biên qua MQTT Cloud, lưu MongoDB Atlas (tự xóa sau 30 ngày)
//  - Luồng C: phát hiện quá tải -> đẩy cảnh báo cho App + ra lệnh ngắt;
//             nhận lệnh bật/tắt từ App -> chuyển xuống Node biên
//  - Luồng D: REST API thống kê lịch sử theo ngày/tuần/tháng + phục vụ dashboard
// ============================================================
require('dotenv').config({ quiet: true });
const path = require('path');
const mqtt = require('mqtt');
const express = require('express');
const { MongoClient } = require('mongodb');

const ROOM = process.env.ROOM_ID || 'A101';
const OVERLOAD_W = Number(process.env.OVERLOAD_W || 2000);
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
const PORT = Number(process.env.CLOUD_PORT || 4000);

const T = {
    telemetry: `smartroom/${ROOM}/telemetry`, // edge -> cloud
    alert: `smartroom/${ROOM}/alert`,         // cloud -> app
    appCmd: `smartroom/${ROOM}/app_cmd`,      // app -> cloud
    edgeCmd: `smartroom/${ROOM}/edge_cmd`,    // cloud -> edge
};

async function main() {
    // ---------- MongoDB Atlas ----------
    const mongo = new MongoClient(process.env.MONGO_URI);
    await mongo.connect();
    const db = mongo.db(process.env.MONGO_DB || 'smartroom');
    const telemetry = db.collection('telemetry');
    const alerts = db.collection('alerts');
    // TTL index: Atlas tự xóa bản ghi cũ hơn RETENTION_DAYS ngày
    await telemetry.createIndex({ ts: 1 }, { expireAfterSeconds: RETENTION_DAYS * 86400 }).catch(async (e) => {
        if (e.codeName !== 'IndexOptionsConflict') throw e;
        await db.command({ collMod: 'telemetry', index: { keyPattern: { ts: 1 }, expireAfterSeconds: RETENTION_DAYS * 86400 } });
    });
    await telemetry.createIndex({ room: 1, ts: -1 });
    console.log(`[CLOUD] Đã kết nối MongoDB Atlas (giữ dữ liệu ${RETENTION_DAYS} ngày)`);

    // ---------- MQTT Cloud ----------
    const cloud = mqtt.connect(process.env.CLOUD_MQTT_URL || `mqtts://${process.env.HIVEMQ_HOST}:8883`, {
        username: process.env.HIVEMQ_USER || undefined,
        password: process.env.HIVEMQ_PASS || undefined,
        clientId: `cloud_${Math.random().toString(16).slice(2, 8)}`,
        reconnectPeriod: 5000,
    });
    cloud.on('connect', () => {
        console.log('[CLOUD] Đã kết nối MQTT Cloud (HiveMQ)');
        cloud.subscribe([T.telemetry, T.appCmd], { qos: 1 });
    });
    cloud.on('error', (e) => console.log('[CLOUD] Lỗi MQTT:', e.message));

    let lastOverloadAt = 0;

    cloud.on('message', async (topic, message) => {
        let data;
        try { data = JSON.parse(message.toString()); } catch { return; }

        // [Luồng A] Lưu dữ liệu
        if (topic === T.telemetry) {
            const doc = { ...data, room: ROOM, ts: new Date(data.timestamp || Date.now()) };
            delete doc.timestamp;
            await telemetry.insertOne(doc).catch((e) => console.log('[CLOUD] Lỗi ghi DB:', e.message));
            console.log(`[CLOUD] Lưu: ${doc.power}W (max ${doc.power_max}W), có người: ${doc.room_occupied}`);

            // [Luồng C] Phát hiện công suất tăng vọt
            const peak = Math.max(doc.power || 0, doc.power_max || 0);
            if (peak > OVERLOAD_W && Date.now() - lastOverloadAt > 15000) {
                lastOverloadAt = Date.now();
                const alert = {
                    type: 'overload',
                    message: `QUÁ TẢI ĐIỆN phòng ${ROOM}: ${peak}W! Đã tự động ngắt điện để bảo vệ.`,
                    power: peak,
                    timestamp: new Date().toISOString(),
                };
                console.log(`[CLOUD] !!! ${alert.message}`);
                cloud.publish(T.alert, JSON.stringify(alert), { qos: 1 });
                cloud.publish(T.edgeCmd, JSON.stringify({ cmd: 'turn_off_all', source: 'overload' }), { qos: 1 });
                alerts.insertOne({ ...alert, room: ROOM, ts: new Date() }).catch(() => {});
            }
        }

        // [Luồng C] Lệnh điều khiển từ Mobile App -> Node biên
        if (topic === T.appCmd) {
            if (!['turn_on_all', 'turn_off_all'].includes(data.cmd)) return;
            console.log(`[CLOUD] Lệnh từ App: ${data.cmd} -> chuyển xuống Node biên`);
            cloud.publish(T.edgeCmd, JSON.stringify({ cmd: data.cmd, source: 'app' }), { qos: 1 });
        }
    });

    // ---------- Luồng D: REST API ----------
    const app = express();
    app.use(express.static(path.join(__dirname, 'public')));

    // Cấu hình MQTT cho dashboard (dùng tài khoản riêng của App, không phải tài khoản server)
    app.get('/api/config', (req, res) => {
        res.json({
            room: ROOM,
            // Để trống DASH_MQTT_WS_URL thì trang tự dùng ws://<máy đang mở trang>:8000/mqtt
            mqttUrl: process.env.DASH_MQTT_WS_URL || null,
            username: process.env.DASH_MQTT_USER || undefined,
            password: process.env.DASH_MQTT_PASS || undefined,
            topics: {
                telemetry: T.telemetry, alert: T.alert, cmd: T.appCmd,
                state: `smartroom/${ROOM}/state`, edgeStatus: `smartroom/${ROOM}/edge_status`,
            },
        });
    });

    // GET /api/history/room/A101?range=day|week|month
    app.get('/api/history/room/:room', async (req, res) => {
        const range = req.query.range || 'day';
        const cfg = {
            day: { ms: 86400e3, unit: 'hour' },
            week: { ms: 7 * 86400e3, unit: 'day' },
            month: { ms: 30 * 86400e3, unit: 'day' },
        }[range];
        if (!cfg) return res.status(400).json({ status: 'error', message: 'range phải là day, week hoặc month' });

        const rows = await telemetry.aggregate([
            { $match: { room: req.params.room, ts: { $gte: new Date(Date.now() - cfg.ms) } } },
            {
                $group: {
                    _id: { $dateTrunc: { date: '$ts', unit: cfg.unit, timezone: 'Asia/Ho_Chi_Minh' } },
                    avg_power: { $avg: '$power' },
                    max_power: { $max: '$power_max' },
                    energy_start: { $min: '$energy_kwh' },
                    energy_end: { $max: '$energy_kwh' },
                    occupied_ratio: { $avg: { $cond: ['$room_occupied', 1, 0] } },
                    samples: { $sum: 1 },
                },
            },
            { $sort: { _id: 1 } },
        ]).toArray();

        res.json({
            status: 'success',
            room: req.params.room,
            range,
            unit: cfg.unit,
            // Điện năng tiêu thụ mỗi mốc = chỉ số công tơ cuối mốc này - cuối mốc trước
            data: rows.map((r, i) => ({
                time: r._id,
                avg_power: +r.avg_power.toFixed(1),
                max_power: r.max_power,
                energy_kwh: +(r.energy_end - (i > 0 ? rows[i - 1].energy_end : r.energy_start)).toFixed(4),
                occupied_percent: Math.round(r.occupied_ratio * 100),
                samples: r.samples,
            })),
        });
    });

    // Bản ghi thô gần nhất (để kiểm tra nhanh)
    app.get('/api/latest/room/:room', async (req, res) => {
        const limit = Math.min(Number(req.query.limit) || 20, 500);
        const data = await telemetry.find({ room: req.params.room }).sort({ ts: -1 }).limit(limit).toArray();
        res.json({ status: 'success', total_records: data.length, data });
    });

    app.get('/api/alerts/room/:room', async (req, res) => {
        const data = await alerts.find({ room: req.params.room }).sort({ ts: -1 }).limit(20).toArray();
        res.json({ status: 'success', data });
    });

    app.listen(PORT, () => {
        console.log(`[CLOUD] Dashboard: http://localhost:${PORT}`);
        console.log(`[CLOUD] API lịch sử: http://localhost:${PORT}/api/history/room/${ROOM}?range=day`);
    });
}

main().catch((e) => {
    console.error('[CLOUD] Không khởi động được:', e.message);
    process.exit(1);
});
