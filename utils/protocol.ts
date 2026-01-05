
/**
 * Calculates XOR CRC (SOF to Data).
 */
export const calculateXOR = (data: Uint8Array): number => {
  return data.reduce((acc, byte) => acc ^ byte, 0);
};

export const uint8ArrayToHex = (data: Uint8Array): string => {
  return Array.from(data)
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
};

export interface DecodedPacket {
  status: number;
  id: number;
  count?: number;
  errorCode: string;
  epc?: string;
  raw: string;
}

/**
 * Builds a Read EPC Data Advance (64H) request packet.
 * 嚴格對齊規範 4-15: 
 * [SOF:80] + [LEN:000E] + [CMD:64] + [ID:1] + [CH:1] + [Pwr:2] + [TO:4] + [Count:4] + [CRC:1]
 * 總計 17 Bytes, Length 欄位值為 14 (0x0E)
 */
export const buildReadEPCRequest = (
  id: number,
  antenna: number,
  power: number,
  timeoutMs: number,
  maxRecords: number
): Uint8Array => {
  const packet = new Uint8Array(17);
  packet[0] = 0x80; // SOF
  packet[1] = 0x00; 
  packet[2] = 0x0E; // Length: CMD(1) + Data(ID:1, CH:1, Pwr:2, TO:4, Count:4) + CRC(1) = 14 (0x0E)
  
  packet[3] = 0x64; // CMD
  packet[4] = id & 0xFF;
  packet[5] = antenna & 0xFF;
  
  // Tx Power (2 bytes, MSB)
  packet[6] = (power >> 8) & 0xFF;
  packet[7] = power & 0xFF;
  
  // Timeout (4 bytes, MSB)
  packet[8] = (timeoutMs >> 24) & 0xFF;
  packet[9] = (timeoutMs >> 16) & 0xFF;
  packet[10] = (timeoutMs >> 8) & 0xFF;
  packet[11] = timeoutMs & 0xFF;
  
  // Data Count (4 bytes, MSB)
  const count = maxRecords > 0 ? maxRecords : 0xFFFFFFFF;
  packet[12] = (count >> 24) & 0xFF;
  packet[13] = (count >> 16) & 0xFF;
  packet[14] = (count >> 8) & 0xFF;
  packet[15] = count & 0xFF;
  
  // CRC: 計算從 packet[0] 到 packet[15]
  packet[16] = calculateXOR(packet.slice(0, 16));
  
  return packet;
};

/**
 * 64H 響應解析器
 */
export const scanAllPackets = (buffer: Uint8Array): DecodedPacket[] => {
  const foundPackets: DecodedPacket[] = [];
  let i = 0;

  while (i < buffer.length) {
    if (buffer[i] === 0x08) { // 響應 SOF 為 0x08
      if (i + 3 <= buffer.length) {
        const dataLen = (buffer[i + 1] << 8) | buffer[i + 2];
        const potentialEnd = i + dataLen + 3; 

        if (potentialEnd <= buffer.length) {
          const packet = buffer.slice(i, potentialEnd);
          if (packet[3] === 0x64) {
            // 結束包判斷: 根據 Response 表格，末尾結構固定為:
            // [Status:1][Count:4][Error:2][CRC:1] 共 8 bytes
            const status = packet[packet.length - 8]; 
            let decoded: DecodedPacket = {
              status, id: packet[4], errorCode: 'N/A', raw: uint8ArrayToHex(packet)
            };

            if (status === 0x01) { // 結束包
              const countIdx = packet.length - 7;
              decoded.count = ((packet[countIdx] << 24) | (packet[countIdx+1] << 16) | (packet[countIdx+2] << 8) | packet[countIdx+3]) >>> 0;
              // Error Code 是 CRC(最後1位) 前面的 2 個 Bytes
              decoded.errorCode = uint8ArrayToHex(packet.slice(packet.length - 3, packet.length - 1)).replace(/\s/g, '');
            } else if (status === 0x00) { // 數據包
              // 根據範例，EPC 資料偏移：SOF(0)+LEN(1,2)+CMD(3)+ID(4)+ANT(5)+Pwr(6)+RSSI(7,8)+EPC(9...)
              // 若有 EPC 資料，其後接 Status(1)+Count(4)+Error(2)+CRC(1)
              const footerLen = 8;
              if (packet.length > 9 + footerLen) {
                decoded.epc = uint8ArrayToHex(packet.slice(9, packet.length - footerLen));
              }
            }
            foundPackets.push(decoded);
            i += packet.length;
            continue;
          }
        }
      }
    }
    i++;
  }
  return foundPackets;
};
