// ============================================================
// NODE SERVER BIÊN (Edge) - chạy tại tòa nhà
//  - Luồng A: nhận dữ liệu ESP32 từ broker nội bộ, gom theo chu kỳ, đẩy lên MQTT Cloud
//  - Luồng B: tự ngắt điện khi phòng trống quá lâu (chạy hoàn toàn nội bộ, không cần Internet)
//  - Luồng C: nhận lệnh từ Cloud Server và chuyển xuống ESP32
// ============================================================
require('dotenv').config({ quiet: true });
const mqtt = require('mqtt');

const ROOM = process.env.ROOM_ID || 'A101';
const UPLINK_INTERVAL_MS = Number(process.env.UPLINK_INTERVAL_MS || 10000);
const EMPTY_TIMEOUT_S = Number(process.env.EMPTY_TIMEOUT_S || 10);
const OVERLOAD_W = Number(process.env.OVERLOAD_W || 2000);

// Topic broker nội bộ (giữ nguyên như sketch ESP32)
const L = {
    presence: `room/${ROOM}/presence`,
    telemetry: `room/${ROOM}/telemetry`,
    state: `room/${ROOM}/state`,
    cmd: `room/${ROOM}/cmd`,
};
// Topic MQTT Cloud
const C = {
    telemetry: `smartroom/${ROOM}/telemetry`, // edge -> cloud
    state: `smartroom/${ROOM}/state`,         // edge -> cloud (trạng thái relay)
    edgeCmd: `smartroom/${ROOM}/edge_cmd`,    // cloud -> edge
    edgeStatus: `smartroom/${ROOM}/edge_status`,
};

// ---------- Kết nối 2 broker ----------
const local = mqtt.connect(process.env.LOCAL_MQTT_URL || 'mqtt://broker.emqx.io');
const cloud = mqtt.connect(process.env.CLOUD_MQTT_URL || `mqtts://${process.env.HIVEMQ_HOST}:8883`, {
    username: process.env.HIVEMQ_USER || undefined,
    password: process.env.HIVEMQ_PASS || undefined,
    clientId: `edge_${ROOM}_${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 5000,
    // Báo "offline" nếu Node biên mất kết nối đột ngột
    will: { topic: C.edgeStatus, payload: JSON.stringify({ online: false }), retain: true },
});

local.on('connect', () => {
    console.log('[EDGE] Đã kết nối broker nội bộ');
    local.subscribe([L.presence, L.telemetry, L.state]);
});
cloud.on('connect', () => {
    console.log('[EDGE] Đã kết nối MQTT Cloud (HiveMQ)');
    cloud.subscribe(C.edgeCmd);
    cloud.publish(C.edgeStatus, JSON.stringify({ online: true }), { retain: true });
});
cloud.on('error', (e) => console.log('[EDGE] Lỗi MQTT Cloud:', e.message));
cloud.on('offline', () => console.log('[EDGE] Mất kết nối Cloud - luồng B vẫn chạy nội bộ'));

function safeParse(buf) {
    try { return JSON.parse(buf.toString()); } catch { return null; }
}

// ---------- Luồng B: bộ đếm phòng trống ----------
let roomOccupied = false;
let emptySince = null;      // thời điểm bắt đầu trống
let autoOffSent = false;    // đã gửi lệnh tắt cho đợt trống này chưa

function sendLocalCmd(cmd, reason) {
    console.log(`[EDGE] -> ESP32: ${cmd} (${reason})`);
    local.publish(L.cmd, JSON.stringify({ cmd }));
}

// ---------- Luồng A: gom dữ liệu để đẩy lên cloud ----------
let buffer = [];
let lastTelemetry = null;

function flushUplink(reason = 'chu kỳ') {
    if (buffer.length === 0) return;
    const n = buffer.length;
    const avg = (k) => buffer.reduce((s, x) => s + (x[k] || 0), 0) / n;
    const record = {
        device_id: buffer[n - 1].device_id,
        room: ROOM,
        timestamp: new Date().toISOString(),
        voltage: +avg('voltage').toFixed(2),
        current: +avg('current').toFixed(3),
        power: +avg('power').toFixed(1),
        power_max: Math.max(...buffer.map((x) => x.power || 0)),
        energy_kwh: buffer[n - 1].energy_kwh,
        room_occupied: roomOccupied,
        samples: n,
    };
    buffer = [];
    cloud.publish(C.telemetry, JSON.stringify(record), { qos: 1 });
    console.log(`[EDGE] ↑ Cloud (${reason}): ${record.power}W TB, max ${record.power_max}W, ${n} mẫu`);
}
setInterval(flushUplink, UPLINK_INTERVAL_MS);

local.on('message', (topic, message) => {
    const data = safeParse(message);
    if (!data) return;

    if (topic === L.presence) {
        const occupied = data.room_occupied === 'Có';
        if (occupied) {
            if (autoOffSent) sendLocalCmd('turn_on_all', 'có người quay lại');
            emptySince = null;
            autoOffSent = false;
        } else if (!emptySince) {
            emptySince = Date.now();
        } else if (!autoOffSent) {
            const s = (Date.now() - emptySince) / 1000;
            console.log(`[EDGE] Phòng trống ${s.toFixed(0)}/${EMPTY_TIMEOUT_S}s`);
            if (s >= EMPTY_TIMEOUT_S) {
                sendLocalCmd('turn_off_all', 'phòng trống quá thời gian');
                autoOffSent = true;
            }
        }
        roomOccupied = occupied;
    }

    if (topic === L.telemetry) {
        lastTelemetry = data;
        buffer.push(data);
        // Công suất vượt ngưỡng: không chờ hết chu kỳ, đẩy lên cloud ngay để cloud cảnh báo
        if (data.power > OVERLOAD_W) flushUplink('vượt ngưỡng');
    }

    if (topic === L.state) {
        // Chuyển trạng thái relay lên cloud cho dashboard (retain để app mở lên là thấy)
        cloud.publish(C.state, JSON.stringify({ ...data, timestamp: new Date().toISOString() }), { retain: true });
    }
});

// ---------- Luồng C: lệnh từ Cloud Server xuống ESP32 ----------
cloud.on('message', (topic, message) => {
    if (topic !== C.edgeCmd) return;
    const data = safeParse(message);
    if (!data || !['turn_on_all', 'turn_off_all'].includes(data.cmd)) return;
    sendLocalCmd(data.cmd, `lệnh từ cloud: ${data.source || 'không rõ'}`);
    // Người dùng chủ động bật/tắt -> reset bộ đếm luồng B
    emptySince = roomOccupied ? null : Date.now();
    autoOffSent = data.cmd === 'turn_off_all';
});
