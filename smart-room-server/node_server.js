const mqtt = require('mqtt');
const express = require('express');

const app = express();
const PORT = 3000;

// Kết nối MQTT Broker
const client = mqtt.connect('mqtt://broker.emqx.io');

let emptyCount = 0;
let historyData = []; // Giả lập Database lưu trên Cloud

client.on('connect', () => {
    console.log('\n--- SERVER ĐÃ KẾT NỐI HỆ THỐNG ---');
    client.subscribe('room/A101/presence');  
    client.subscribe('room/A101/telemetry'); 
});

client.on('message', (topic, message) => {
    const data = JSON.parse(message.toString());

    // ==========================================
    // LUỒNG B: ĐIỆN TOÁN BIÊN (Đếm thời gian & Bật/Tắt tự động)
    // ==========================================
    if (topic === 'room/A101/presence') {
        if (data.room_occupied === 'Có') {
            console.log('Phòng có người -> Reset bộ đếm.');
            
            // Chỉ đẩy lệnh bật đèn xuống nếu trước đó đèn đang bị tắt (bộ đếm > 0)
            if (emptyCount > 0) {
                client.publish('room/A101/cmd', JSON.stringify({ cmd: "turn_on_all" }));
            }
            emptyCount = 0; // Đưa bộ đếm về 0
            
        } else {
            emptyCount++;
            console.log(`Không có người liên tục: ${emptyCount}/10`);
            
            if (emptyCount >= 10) {
                console.log('>>> [LUỒNG B] Hết thời gian trống! Tự động ngắt điện.');
                client.publish('room/A101/cmd', JSON.stringify({ cmd: "turn_off_all" }));
                emptyCount = 0;
            }
        }
    }

    // ==========================================
    // LUỒNG A & C: THU THẬP & CẢNH BÁO QUÁ TẢI TỪ SERVER
    // ==========================================
    if (topic === 'room/A101/telemetry') {
        // [Luồng A] Lưu dữ liệu vào "Database"
        historyData.push({ timestamp: new Date(), ...data });
        if (historyData.length > 100) historyData.shift(); // Lưu tối đa 100 bản ghi gần nhất

        // [Luồng C] Server phân tích dữ liệu, phát hiện vọt công suất
        if (data.power > 2000) {
            console.log(`\n!!! [LUỒNG C] PHÁT HIỆN QUÁ TẢI: ${data.power}W !!!`);
            console.log(' -> Đẩy cảnh báo Pop-up cho Mobile App...');
            client.publish('room/A101/state', JSON.stringify({
                alert: "QUÁ TẢI ĐIỆN! Đã tự động cắt cầu dao để bảo vệ.",
                power: data.power
            }));

            console.log(' -> Server điều khiển chéo ESP32 ngắt Relay...');
            client.publish('room/A101/cmd', JSON.stringify({ cmd: "turn_off_all" }));
        }
    }
});

// ==========================================
// LUỒNG D: HTTP API (Mobile App gọi lấy lịch sử vẽ biểu đồ)
// ==========================================
app.get('/api/history/room/A101', (req, res) => {
    res.json({
        status: "success",
        total_records: historyData.length,
        data: historyData
    });
});

app.listen(PORT, () => {
    console.log(`>>> API Luồng D đang chạy tại: http://localhost:${PORT}/api/history/room/A101`);
});