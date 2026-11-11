# Hệ thống IoT Quản lý năng lượng phòng học thông minh

Đồ án xây dựng hệ thống quản lý năng lượng phân tán sử dụng kiến trúc Điện toán biên (Edge Computing). Hệ thống có khả năng tự động hóa, giám sát và cảnh báo tiêu thụ điện theo thời gian thực.

> Nhánh `cloud`: tách Node Server thành **Node biên (Edge)** và **Cloud Server**, thêm MQTT Cloud (HiveMQ), cơ sở dữ liệu MongoDB Atlas (lưu 30 ngày) và dashboard web thay cho Mobile App.

## ⚙️ Kiến trúc hệ thống

```
ESP32 (Wokwi) ⇄ Broker nội bộ (EMQX) ⇄ edge_server.js ⇄ MQTT Cloud (HiveMQ) ⇄ cloud_server.js ⇄ MongoDB Atlas
                                                                ⇅                      ⇅ HTTP/REST
                                                          Dashboard web (Mobile App, mở được trên điện thoại)
```

| Thành phần | File | Vai trò |
|---|---|---|
| ESP32 | `esp32_wokwi_code.cpp` | Đo điện (biến trở giả lập PZEM-004T), phát hiện người (PIR), đóng/ngắt 2 relay |
| Node biên | `smart-room-server/edge_server.js` | Luồng B tại chỗ; gom dữ liệu đẩy lên cloud; chuyển lệnh cloud xuống ESP32 |
| Cloud Server | `smart-room-server/cloud_server.js` | Lưu Atlas, phát hiện quá tải, nhận lệnh App, REST API lịch sử, phục vụ dashboard |
| Dashboard | `smart-room-server/public/index.html` | Số đo realtime, nút Bật/Tắt, pop-up cảnh báo, biểu đồ ngày/tuần/tháng |
| Bản cũ | `smart-room-server/node_server.js` | Phiên bản 1 server gộp (không chạy chung với bản cloud) |

## 🔀 Luồng dữ liệu (4 luồng)
1. **Luồng A (Telemetry):** ESP32 gửi `room/A101/telemetry` mỗi 5s lên broker nội bộ. Node biên gom và tính trung bình theo chu kỳ `UPLINK_INTERVAL_MS` (demo 10s, thực tế 5 phút) rồi đẩy lên `smartroom/A101/telemetry` trên MQTT Cloud. Cloud Server lưu vào MongoDB Atlas, TTL index tự xóa dữ liệu cũ hơn 30 ngày.
2. **Luồng B (Local Automation):** Node biên đếm thời gian phòng trống từ `room/A101/presence` (1Hz). Quá `EMPTY_TIMEOUT_S` (10s) thì gửi `turn_off_all` xuống ESP32, có người quay lại thì gửi `turn_on_all`. Toàn bộ chạy trong mạng nội bộ, mất Internet vẫn hoạt động.
3. **Luồng C (Real-time Alert & Control):**
   - Cảnh báo: công suất > 2000W thì Node biên đẩy dữ liệu lên ngay (không chờ chu kỳ). Cloud Server phát `smartroom/A101/alert` (dashboard hiện pop-up) và gửi lệnh ngắt qua `smartroom/A101/edge_cmd`.
   - Điều khiển từ xa: Dashboard → `smartroom/A101/app_cmd` → Cloud Server → `edge_cmd` → Node biên → `room/A101/cmd` → ESP32.
4. **Luồng D (REST API):** `GET /api/history/room/A101?range=day|week|month` trả về điện năng (kWh) và công suất trung bình theo giờ/ngày, truy vấn trực tiếp từ Atlas.

## 🛠 Phần cứng & Công nghệ
- **Phần cứng (Wokwi):** ESP32-WROOM-32, PIR HLK-LD2410, PZEM-004T (mô phỏng qua biến trở), Module Relay.
- **Phần mềm:** Node.js (Express, MQTT.js, MongoDB driver), HiveMQ (Docker), MongoDB Atlas, EMQX Broker Public, Chart.js, MQTTX.

## 🚀 Cách chạy dự án

### 1. Chuẩn bị (làm một lần)
- **MongoDB Atlas:** tạo cluster M0 Free, tạo database user, thêm `0.0.0.0/0` ở Network Access, lấy chuỗi kết nối ở *Connect → Drivers*.
- **HiveMQ bằng Docker** (đóng vai trò MQTT Cloud; cổng 1883 cho server, 8000 WebSocket cho dashboard, 8080 Control Center):
  ```powershell
  docker run -d --name hivemq -p 1883:1883 -p 8000:8000 -p 8080:8080 `
    -e HIVEMQ_LICENSE_KEY=<license key> -e HIVEMQ_ALLOW_ALL_CLIENTS=true `
    hivemq/hivemq4:latest
  ```
  Những lần sau chỉ cần `docker start hivemq` (hoặc bấm ▶ trong Docker Desktop).
- **Cấu hình:**
  ```bash
  cd smart-room-server
  npm install
  cp .env.example .env   # rồi điền MONGO_URI
  ```
  Không commit file `.env` (đã có trong `.gitignore`).

### 2. Chạy demo
1. Dán code `esp32_wokwi_code.cpp` vào Wokwi (thêm thư viện `PubSubClient`, `ArduinoJson`) và nhấn Play.
2. Terminal 1: `npm run edge`
3. Terminal 2: `npm run cloud`
4. Mở dashboard: http://localhost:4000 (trên điện thoại cùng wifi: `http://<IP-laptop>:4000`).

### 3. Kịch bản kiểm thử
| Luồng | Thao tác | Kết quả |
|---|---|---|
| A | Để hệ thống chạy | Terminal cloud in `Lưu: ...W`; dữ liệu xuất hiện trong `smartroom.telemetry` trên Atlas |
| B | Không kích hoạt PIR | Sau 10s LED tắt; *Simulate motion* trên PIR thì LED sáng lại |
| C | Kéo biến trở > ~60% | Pop-up quá tải trên dashboard, relay bị ngắt |
| C | Bấm Bật/Tắt trên dashboard | LED đổi trạng thái sau ~1-2s |
| D | Chọn tab Ngày/Tuần/Tháng | Biểu đồ điện năng từ Atlas |

### Chạy bản cũ (một server gộp)
```bash
npm run legacy
```
