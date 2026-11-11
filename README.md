# Hệ thống IoT Quản lý năng lượng phòng học thông minh

Đồ án xây dựng hệ thống quản lý năng lượng phân tán sử dụng kiến trúc Điện toán biên (Edge Computing). Hệ thống có khả năng tự động hóa, giám sát và cảnh báo tiêu thụ điện theo thời gian thực.

## ⚙️ Kiến trúc hệ thống & Luồng dữ liệu (4 Luồng)
1. **Luồng A (Telemetry):** ESP32 định kỳ đo điện áp, dòng điện, công suất và đẩy lên Broker. Node Server ghi nhận và lưu trữ làm cơ sở dữ liệu.
2. **Luồng B (Local Automation):** Cảm biến PIR báo cáo hiện diện (1Hz). Node Server đếm thời gian phòng trống, nếu quá 10 giây sẽ tự động gửi lệnh cắt điện mà không cần con người can thiệp (Độ trễ siêu thấp).
3. **Luồng C (Real-time Alert & Control):** 
   - Điều khiển từ xa: Người dùng gửi lệnh `turn_on_all` / `turn_off_all` thông qua MQTT.
   - Cảnh báo: Khi Server nhận thấy công suất > 2000W, nó tự động nổ popup cảnh báo và điều khiển chéo ESP32 ngắt cầu dao ngay lập tức.
4. **Luồng D (REST API):** Node Server cung cấp HTTP API trả về lịch sử đo đạc định dạng JSON phục vụ vẽ biểu đồ trên Mobile App.

## 🛠 Phần cứng & Công nghệ
- **Phần cứng (Wokwi):** ESP32-WROOM-32, PIR HLK-LD2410, PZEM-004T (Mô phỏng qua Biến trở), Module Relay.
- **Phần mềm:** Node.js (Express, MQTT), MQTTX, EMQX Broker Public.

## 🚀 Cách chạy dự án
1. **Chạy ESP32:** Copy code trong file `esp32_wokwi_code.ino` dán vào nền tảng Wokwi và nhấn Play.
2. **Chạy Node Server (Cloud + Edge):**
   ```bash
   npm install
   node node_server.js
