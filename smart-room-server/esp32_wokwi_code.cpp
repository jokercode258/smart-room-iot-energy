#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

const char* ssid = "Wokwi-GUEST";
const char* password = "";
const char* mqtt_server = "broker.emqx.io";

WiFiClient espClient;
PubSubClient client(espClient);

const int relayAC = 5;
const int relayLight = 19;
const int pirPin = 18;
const int potPin = 34;

long telemetryInterval = 5000;
long presenceInterval = 1000;
unsigned long lastTelemetryTime = 0;
unsigned long lastPresenceTime = 0;
float accumulated_kWh = 150.5;

void setup_wifi() {
  delay(10);
  Serial.println();
  Serial.print("Đang kết nối Wi-Fi: ");
  Serial.println(ssid);
  
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) { 
    delay(500); 
    Serial.print(".");
  }
  Serial.println("\nĐã kết nối Wi-Fi thành công!");
}

void sendMeta() {
  StaticJsonDocument<256> doc;
  doc["device_id"] = "ROOM_A101_NODE";
  doc["hardware"] = "ESP32-WROOM-32";
  doc["sensor_motion"] = "PIR/HLK-LD2410 (GPIO 18)";
  doc["sensor_power"] = "PZEM-004T (GPIO 34)";
  char buffer[256]; 
  serializeJson(doc, buffer);
  client.publish("room/A101/meta", buffer);
  Serial.println("Đã gửi bản tin Meta (Phần cứng)");
}

void sendState() {
  StaticJsonDocument<256> doc;
  doc["device_id"] = "ROOM_A101_NODE";
  doc["relay_ac"] = digitalRead(relayAC) == HIGH ? "Bật" : "Tắt";
  doc["relay_light"] = digitalRead(relayLight) == HIGH ? "Bật" : "Tắt";
  char buffer[256]; 
  serializeJson(doc, buffer);
  client.publish("room/A101/state", buffer);
  Serial.println("Đã cập nhật trạng thái State");
}

void sendTelemetry(float v, float a, float w) {
  StaticJsonDocument<256> doc;
  doc["device_id"] = "ROOM_A101_NODE";
  doc["voltage"] = v;
  doc["current"] = a;
  doc["power"] = w;
  doc["energy_kwh"] = accumulated_kWh;
  char buffer[256]; 
  serializeJson(doc, buffer);
  client.publish("room/A101/telemetry", buffer);
  Serial.println("Đã gửi Telemetry (Luồng A): " + String(w) + "W");
  // LƯU Ý: Đã xóa phần if (w > 2000) ở đây. Quyền quyết định giờ thuộc về Server.
}

void sendPresence(bool isOccupied) {
  StaticJsonDocument<128> doc;
  doc["device_id"] = "ROOM_A101_NODE";
  doc["room_occupied"] = isOccupied ? "Có" : "Không";
  char buffer[128]; 
  serializeJson(doc, buffer);
  client.publish("room/A101/presence", buffer);
}

void callback(char* topic, byte* payload, unsigned int length) {
  Serial.print("Nhận lệnh Downlink: ");
  StaticJsonDocument<256> doc;
  deserializeJson(doc, payload, length);
  String command = doc["cmd"];
  Serial.println(command);
  
  if (command == "turn_on_all") {
    digitalWrite(relayAC, HIGH);
    digitalWrite(relayLight, HIGH);
    sendState();
  } 
  else if (command == "turn_off_all") {
    digitalWrite(relayAC, LOW);
    digitalWrite(relayLight, LOW);
    sendState();
  }
}

void reconnect() {
  while (!client.connected()) {
    Serial.print("Đang kết nối MQTT Broker... ");
    String clientId = "ROOM_A101_NODE_" + String(random(0xffff), HEX);
    
    if (client.connect(clientId.c_str())) {
      Serial.println("Thành công!");
      client.subscribe("room/A101/cmd"); 
      sendMeta();                        
      sendState();                       
    } else { 
      Serial.print("Thất bại. Thử lại sau 5s...");
      delay(5000); 
    }
  }
}

void setup() {
  Serial.begin(115200); 
  
  pinMode(relayAC, OUTPUT); 
  pinMode(relayLight, OUTPUT);
  pinMode(pirPin, INPUT);
  
  digitalWrite(relayAC, LOW);
  digitalWrite(relayLight, LOW);
  
  setup_wifi();
  client.setServer(mqtt_server, 1883);
  client.setCallback(callback);
}

void loop() {
  if (!client.connected()) reconnect();
  client.loop();

  unsigned long currentMillis = millis();
  bool motion = digitalRead(pirPin) == HIGH;
  
  int potValue = analogRead(potPin);
  float mockPower = map(potValue, 0, 4095, 0, 3500); 
  float mockCurrent = mockPower / 220.5;

  // Luồng B
  if (currentMillis - lastPresenceTime > presenceInterval) {
    lastPresenceTime = currentMillis;
    sendPresence(motion);
  }

  // Luồng A
  if (currentMillis - lastTelemetryTime > telemetryInterval) {
    lastTelemetryTime = currentMillis;
    accumulated_kWh += (mockPower / 1000.0) * (telemetryInterval / 3600000.0);
    sendTelemetry(220.5, mockCurrent, mockPower);
  }
}