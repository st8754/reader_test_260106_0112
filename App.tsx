
import React, { useState, useEffect, useRef } from 'react';
import { 
  Download, Activity, Settings, Database, Terminal, RefreshCw, Cpu, Monitor, Tag, Zap, ListOrdered, XCircle, CheckCircle2, BarChart3, AlertCircle, Clock, Server, ShieldAlert, Globe, Lock, Unlock, ShieldCheck, Home
} from 'lucide-react';
import { TestConfig, TestResult, ERROR_CODES } from './types';
import { 
  buildReadEPCRequest, uint8ArrayToHex, scanAllPackets, DecodedPacket 
} from './utils/protocol';

interface ExtendedTestResult extends TestResult {
  configTimeout: number;
  configPower: number;
  configMaxRecords: number;
  epcList: string[];
}

interface RawLogEntry {
  timestamp: string;
  data: string;
}

const App: React.FC = () => {
  const [isLocalFile, setIsLocalFile] = useState(false);
  const [isSecureContext, setIsSecureContext] = useState(window.isSecureContext);
  const [isLocalhost, setIsLocalhost] = useState(
    window.location.hostname === 'localhost' || 
    window.location.hostname === '127.0.0.1'
  );
  const [port, setPort] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [config, setConfig] = useState<TestConfig>({
    totalCycles: 10,
    timeoutMs: 5000,
    intervalMs: 500,
    maxRecords: 10,
    id: 1,
    channel: 0,
    power: 33,
    baudRate: 38400,
    stopOnError: true,
  });
  const [results, setResults] = useState<ExtendedTestResult[]>([]);
  const [currentCycle, setCurrentCycle] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [rawRxLogs, setRawRxLogs] = useState<RawLogEntry[]>([]);

  const masterBufferRef = useRef<Uint8Array>(new Uint8Array(0));
  const isReadingRef = useRef<boolean>(false);
  const backgroundReaderRef = useRef<any>(null);
  const stopRequestedRef = useRef<boolean>(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const rawLogEndRef = useRef<HTMLDivElement>(null);

  // 版本標記
  const LAST_UPDATED = "2026-01-02 10:45 (Local Optimized)";

  useEffect(() => {
    if (window.location.protocol === 'file:') {
      setIsLocalFile(true);
    }
  }, []);

  useEffect(() => {
    if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    if (rawLogEndRef.current) rawLogEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [rawRxLogs]);

  const addLog = (msg: string, type: 'tx' | 'rx' | 'system' | 'error' | 'info' | 'tag' = 'info') => {
    const timestamp = new Date().toLocaleTimeString('zh-TW', { hour12: false, fractionalSecondDigits: 3 } as any);
    const prefix = { tx: '>> ', rx: '<< ', system: '[SYS] ', error: '[ERR] ', info: '  ', tag: '[TAG] ' }[type];
    setLogs(prev => [...prev, `${timestamp} ${prefix}${msg}`].slice(-500));
  };

  const addRawRxLog = (data: Uint8Array) => {
    const timestamp = new Date().toLocaleTimeString('zh-TW', { hour12: false, fractionalSecondDigits: 3 } as any);
    const hex = uint8ArrayToHex(data);
    setRawRxLogs(prev => [...prev, { timestamp, data: hex }].slice(-200));
  };

  const startBackgroundRead = async (portObj: any) => {
    if (isReadingRef.current) return;
    isReadingRef.current = true;
    const reader = portObj.readable.getReader();
    backgroundReaderRef.current = reader;
    try {
      while (isReadingRef.current) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          addRawRxLog(value);
          const next = new Uint8Array(masterBufferRef.current.length + value.length);
          next.set(masterBufferRef.current);
          next.set(value, masterBufferRef.current.length);
          masterBufferRef.current = next;
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') console.error(err);
    } finally {
      reader.releaseLock();
      isReadingRef.current = false;
    }
  };

  const connectSerial = async () => {
    const serial = (navigator as any).serial;
    if (!serial) {
      const errorMsg = !isSecureContext 
        ? "連線失敗：Web Serial 需要 HTTPS 加密網址或 localhost。" 
        : "連線失敗：您的瀏覽器不支持 Web Serial (請使用 Chrome/Edge)。";
      addLog(errorMsg, 'error');
      alert(errorMsg);
      return;
    }
    try {
      const selectedPort = await serial.requestPort();
      await selectedPort.open({ baudRate: config.baudRate });
      setPort(selectedPort);
      setIsConnected(true);
      addLog(`連線成功: 38400 bps N81`, 'system');
      startBackgroundRead(selectedPort);
    } catch (err: any) {
      addLog("連線失敗: " + err.message, 'error');
    }
  };

  const disconnectSerial = async () => {
    if (isTesting) stopRequestedRef.current = true;
    isReadingRef.current = false;
    if (backgroundReaderRef.current) await backgroundReaderRef.current.cancel();
    if (port) {
      await port.close();
      setPort(null); setIsConnected(false); setIsTesting(false);
      addLog("串口關閉", 'system');
    }
  };

  const runSingleTest = async (cycle: number): Promise<ExtendedTestResult | null> => {
    if (!port || !port.writable) return null;
    masterBufferRef.current = new Uint8Array(0);
    const txBuffer = buildReadEPCRequest(config.id, config.channel, config.power, config.timeoutMs, config.maxRecords);
    const writer = port.writable.getWriter();
    await writer.write(txBuffer);
    writer.releaseLock();
    
    addLog(`TX發送: ${uint8ArrayToHex(txBuffer)} (LEN:0x0E)`, 'tx');
    const startTime = Date.now();
    const deadline = startTime + config.timeoutMs + 2000; 
    let foundEndPacket = false;
    let finalErrorCode = 'N/A';
    let finalCount = 0;
    let localEpcList: string[] = [];
    let processedRawPackets = new Set<string>();

    while (Date.now() < deadline && !stopRequestedRef.current) {
      const packets = scanAllPackets(masterBufferRef.current);
      packets.forEach(p => {
        if (!processedRawPackets.has(p.raw)) {
          processedRawPackets.add(p.raw);
          if (p.status === 0x00 && p.epc) {
            addLog(`EPC: ${p.epc}`, 'tag');
            if (!localEpcList.includes(p.epc)) localEpcList.push(p.epc);
          } else if (p.status === 0x01) {
            foundEndPacket = true;
            finalCount = p.count || 0;
            finalErrorCode = p.errorCode;
            addLog(`結束包: ${p.raw.slice(-24)}`, 'rx');
          }
        }
      });
      if (foundEndPacket) break;
      await new Promise(r => setTimeout(r, 100));
    }

    const isSuccess = foundEndPacket && finalErrorCode === '0001';
    const statusText: any = isSuccess ? 'Success' : (foundEndPacket ? 'Failure' : 'Timeout');

    return {
      timestamp: new Date().toISOString(),
      cycle,
      status: statusText,
      errorCode: finalErrorCode,
      errorMsg: ERROR_CODES[finalErrorCode] || (statusText === 'Timeout' ? '逾時無回應' : '指令異常'),
      rawTx: uint8ArrayToHex(txBuffer),
      rawRx: uint8ArrayToHex(masterBufferRef.current),
      recordsFound: finalCount,
      configTimeout: config.timeoutMs,
      configPower: config.power,
      configMaxRecords: config.maxRecords,
      epcList: localEpcList
    };
  };

  const startTesting = async () => {
    if (!isConnected) return;
    setIsTesting(true);
    stopRequestedRef.current = false;
    setResults([]);
    setLogs([]);
    setRawRxLogs([]);
    addLog(`===== 啟動自動化測試 (Cycle: ${config.totalCycles}) =====`, 'system');

    for (let i = 1; i <= config.totalCycles; i++) {
      if (stopRequestedRef.current) break;
      setCurrentCycle(i);
      const res = await runSingleTest(i);
      if (res) {
        setResults(prev => [...prev, res]);
        if (config.stopOnError && res.status !== 'Success') break;
      }
      if (config.intervalMs > 0 && i < config.totalCycles) await new Promise(r => setTimeout(r, config.intervalMs));
    }
    setIsTesting(false);
  };

  if (isLocalFile) return null;

  const total = results.length;
  const successCount = results.filter(r => r.status === 'Success').length;
  const failureCount = total - successCount;
  const successRate = total > 0 ? (successCount / total * 100).toFixed(1) : '0';

  return (
    <div className="p-4 md:p-8 bg-slate-50 min-h-screen text-slate-700 font-sans animate-in fade-in duration-700 relative pb-24">
      <header className="mb-8 flex flex-col md:flex-row items-center justify-between gap-6 bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200">
        <div className="flex items-center gap-5">
          <div className="p-4 bg-indigo-600 rounded-2xl shadow-xl shadow-indigo-100"><Activity className="text-white w-7 h-7" /></div>
          <div>
            <h1 className="text-2xl font-black text-slate-800 tracking-tight tracking-tight italic">RFID 64H STABILITY PRO</h1>
            <div className="flex flex-wrap items-center gap-2 mt-1">
               <span className={`flex items-center gap-1.5 text-[10px] font-bold px-3 py-1 rounded-full ${isConnected ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                  {isConnected ? 'DEVICE ONLINE' : 'DISCONNECTED'}
               </span>
               <div className="flex gap-2">
                 <span className={`flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-md border ${isSecureContext ? 'bg-indigo-50 border-indigo-100 text-indigo-600' : 'bg-rose-50 border-rose-100 text-rose-600'}`}>
                    {isSecureContext ? <Lock className="w-2 h-2" /> : <Unlock className="w-2 h-2" />}
                    {isSecureContext ? 'HTTPS' : 'UNSECURE'}
                 </span>
                 <span className={`flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-md border font-bold ${isLocalhost ? 'bg-emerald-50 border-emerald-100 text-emerald-600' : 'bg-blue-50 border-blue-100 text-blue-600'}`}>
                    {isLocalhost ? <Home className="w-2.5 h-2.5" /> : <Globe className="w-2.5 h-2.5" />}
                    {isLocalhost ? 'LOCALHOST' : 'REMOTE'}
                 </span>
               </div>
            </div>
          </div>
        </div>
        <div className="flex gap-4">
          {!isConnected ? (
            <button onClick={connectSerial} className="bg-slate-900 text-white px-8 py-3.5 rounded-2xl font-bold hover:bg-black transition-all shadow-lg active:scale-95">連線設備</button>
          ) : (
            <button onClick={disconnectSerial} className="bg-white text-rose-500 px-6 py-3.5 rounded-2xl font-bold border border-rose-100 hover:bg-rose-50 transition-all flex items-center gap-2 active:scale-95">
              <RefreshCw className="w-4 h-4" /> 斷開
            </button>
          )}
          <button 
            onClick={isTesting ? () => stopRequestedRef.current = true : startTesting} 
            disabled={!isConnected} 
            className={`px-10 py-3.5 rounded-2xl font-black transition-all shadow-lg active:scale-95 ${
              isTesting ? 'bg-rose-500 text-white shadow-rose-200 animate-pulse' : 'bg-indigo-600 text-white shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-30'
            }`}
          >
            {isTesting ? '停止測試' : '開始測試'}
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
        <div className="xl:col-span-3 space-y-8">
          <section className="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm space-y-6">
            <h3 className="text-xs font-black uppercase text-slate-400 tracking-widest flex items-center gap-2 border-b pb-4"><Settings className="w-4 h-4" /> 參數配置</h3>
            <div className="space-y-4">
               <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                    <label className="text-[10px] font-black text-slate-400 uppercase block mb-1">測試輪次</label>
                    <input type="number" value={config.totalCycles} onChange={e => setConfig({...config, totalCycles: parseInt(e.target.value) || 1})} className="w-full bg-transparent font-black text-slate-700 outline-none text-lg" />
                  </div>
                  <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                    <label className="text-[10px] font-black text-slate-400 uppercase block mb-1 flex items-center gap-1"><Clock className="w-2.5 h-2.5" /> 輪次間隔 (ms)</label>
                    <input type="number" value={config.intervalMs} onChange={e => setConfig({...config, intervalMs: parseInt(e.target.value) || 0})} className="w-full bg-transparent font-black text-slate-700 outline-none text-lg" />
                  </div>
               </div>
               
               <div className="bg-indigo-50/50 p-5 rounded-3xl border border-indigo-100 space-y-4">
                  <label className="text-[10px] font-black text-indigo-400 uppercase tracking-widest flex items-center gap-2"><Zap className="w-3 h-3" /> TX 指令參數</label>
                  <div className="grid grid-cols-1 gap-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-white p-3 rounded-xl border border-indigo-100 shadow-sm">
                        <label className="text-[9px] font-black text-slate-400 uppercase block">功率 (dBm)</label>
                        <input type="number" value={config.power} onChange={e => setConfig({...config, power: parseInt(e.target.value) || 5})} className="w-full bg-transparent font-black text-indigo-700 outline-none text-lg" />
                      </div>
                      <div className="bg-white p-3 rounded-xl border border-indigo-100 shadow-sm">
                        <label className="text-[9px] font-black text-slate-400 uppercase block">目標筆數</label>
                        <input type="number" value={config.maxRecords} onChange={e => setConfig({...config, maxRecords: parseInt(e.target.value) || 0})} className="w-full bg-transparent font-black text-indigo-700 outline-none text-lg" />
                      </div>
                    </div>
                    <div className="bg-white p-3 rounded-xl border border-indigo-100 shadow-sm">
                      <label className="text-[9px] font-black text-slate-400 uppercase block flex items-center gap-1">搜尋時間 (Timeout MS)</label>
                      <input type="number" value={config.timeoutMs} onChange={e => setConfig({...config, timeoutMs: parseInt(e.target.value) || 100})} className="w-full bg-transparent font-black text-indigo-700 outline-none text-lg" />
                    </div>
                  </div>
               </div>
            </div>
          </section>

          <section className="bg-slate-900 p-8 rounded-[2rem] text-white shadow-2xl space-y-6 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-8 opacity-10"><BarChart3 className="w-20 h-20" /></div>
            <div className="relative z-10">
              <h3 className="text-[10px] font-black uppercase opacity-40 mb-2">穩定性指標</h3>
              <div className="text-6xl font-black tracking-tighter text-emerald-400">{successRate}%</div>
              <div className="flex gap-4 mt-4">
                 <div className="text-xs font-black text-emerald-400">PASS: {successCount}</div>
                 <div className="text-xs font-black text-rose-400">FAIL: {failureCount}</div>
              </div>
            </div>
            <button onClick={() => {
              const headers = ["輪次", "結果", "設定功率", "讀取時間", "讀取筆數", "錯誤碼", "TX指令", "接收數據"];
              const csv = "\ufeff" + [headers, ...results.map(r => [r.cycle, r.status, r.configPower, r.configTimeout, r.recordsFound, r.errorCode, r.rawTx, r.rawRx])].map(e => e.join(",")).join("\n");
              const link = document.createElement("a");
              link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
              link.download = `RFID_Stability_Report_${Date.now()}.csv`;
              link.click();
            }} className="w-full bg-indigo-600 hover:bg-indigo-500 py-4 rounded-2xl text-xs font-black transition-all flex items-center justify-center gap-2 relative z-10 active:scale-95 shadow-lg shadow-indigo-900/50">
              <Download className="w-4 h-4" /> 輸出 CSV 報告
            </button>
          </section>
        </div>

        <div className="xl:col-span-9 space-y-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-[2rem] shadow-xl overflow-hidden flex flex-col h-[400px] border border-slate-200">
              <div className="px-6 py-4 bg-slate-900 flex justify-between items-center border-b border-slate-800">
                <span className="text-indigo-400 text-[11px] font-black uppercase tracking-[0.2em] flex items-center gap-3">
                  <Terminal className="w-4 h-4" /> 協議追蹤監控 (Trace)
                </span>
                <button onClick={() => setLogs([])} className="text-[10px] font-bold text-slate-500 hover:text-white uppercase active:opacity-50">清除</button>
              </div>
              <div className="p-6 overflow-y-auto flex-1 font-mono text-[10px] leading-relaxed text-slate-400 bg-slate-950 custom-scrollbar">
                {logs.length === 0 && <div className="text-slate-800 italic opacity-50">等待指令發送...</div>}
                {logs.map((log, i) => {
                  let color = "text-slate-500";
                  if (log.includes(">>")) color = "text-indigo-400 font-bold border-l-2 border-indigo-900 pl-4 my-1";
                  if (log.includes("EPC:")) color = "text-emerald-400 font-black py-1.5 px-4 bg-emerald-900/10 rounded-lg my-1";
                  if (log.includes("結束包")) color = "text-white font-bold bg-slate-900 px-4 py-2 rounded-lg my-2 border border-slate-800";
                  return <div key={i} className={`${color} py-0.5 whitespace-pre-wrap`}>{log}</div>;
                })}
                <div ref={logEndRef} />
              </div>
            </div>

            <div className="bg-white rounded-[2rem] shadow-xl overflow-hidden flex flex-col h-[400px] border border-slate-200">
              <div className="px-6 py-4 bg-slate-900 flex justify-between items-center border-b border-slate-800">
                <span className="text-emerald-400 text-[11px] font-black uppercase tracking-[0.2em] flex items-center gap-3">
                  <Monitor className="w-4 h-4" /> 接收原始數據 (Raw RX)
                </span>
                <button onClick={() => setRawRxLogs([])} className="text-[10px] font-bold text-slate-500 hover:text-white uppercase active:opacity-50">清除</button>
              </div>
              <div className="p-6 overflow-y-auto flex-1 font-mono text-[10px] leading-relaxed text-slate-400 bg-black custom-scrollbar">
                {rawRxLogs.length === 0 && <div className="text-slate-800 italic opacity-50">尚未接收到數據字節...</div>}
                {rawRxLogs.map((log, i) => (
                  <div key={i} className="flex gap-4 border-b border-slate-900 py-2 group hover:bg-slate-900/30 transition-colors">
                    <span className="text-slate-600 font-bold shrink-0">[{log.timestamp}]</span>
                    <span className="text-emerald-500/80 break-all">{log.data}</span>
                  </div>
                ))}
                <div ref={rawLogEndRef} />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden mb-12">
            <div className="px-8 py-5 border-b bg-slate-50/50 flex items-center justify-between">
              <h3 className="text-sm font-black text-slate-800 flex items-center gap-3"><Database className="w-5 h-5 text-indigo-500" /> 歷史測試詳情</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead className="bg-white font-black text-slate-400 uppercase border-b">
                  <tr>
                    <th className="p-6">輪次</th>
                    <th className="p-6">結果</th>
                    <th className="p-6">指令 Timeout</th>
                    <th className="p-6">讀取筆數</th>
                    <th className="p-6">錯誤描述</th>
                    <th className="p-6 text-right">時間</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {results.length === 0 ? (
                    <tr><td colSpan={6} className="p-20 text-center text-slate-300 font-bold uppercase italic tracking-widest opacity-30 text-2xl">No Test Conducted</td></tr>
                  ) : results.map((r, i) => (
                    <tr key={i} className="hover:bg-slate-50/50 transition-all">
                      <td className="p-6 font-black text-slate-400">#{r.cycle.toString().padStart(3, '0')}</td>
                      <td className="p-6">
                        <span className={`px-4 py-1.5 rounded-full text-[10px] font-black uppercase flex items-center gap-2 w-fit ${
                          r.status === 'Success' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
                        }`}>
                          {r.status === 'Success' ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                          {r.status}
                        </span>
                      </td>
                      <td className="p-6 font-bold text-slate-400">{r.configTimeout} ms</td>
                      <td className="p-6 font-black text-slate-600 text-sm">{r.recordsFound} <span className="text-[10px] text-slate-300">Tags</span></td>
                      <td className="p-6">
                        <div className="flex items-center gap-3">
                           <span className="font-mono text-slate-400 font-bold bg-slate-100 px-2 py-0.5 rounded-md">{r.errorCode}</span>
                           <span className="text-[10px] font-bold text-slate-400">{r.errorMsg}</span>
                        </div>
                      </td>
                      <td className="p-6 text-right text-slate-400 font-bold tabular-nums">{new Date(r.timestamp).toLocaleTimeString([], { hour12: false })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <footer className="fixed bottom-0 left-0 right-0 bg-white/80 backdrop-blur-md border-t border-slate-200 px-8 py-4 flex flex-col md:flex-row items-center justify-between gap-4 z-50">
        <div className="flex items-center gap-3 opacity-60 hover:opacity-100 transition-opacity">
           <div className="p-2 bg-emerald-100 rounded-lg"><ShieldCheck className="w-4 h-4 text-emerald-600" /></div>
           <div>
             <p className="text-[10px] font-black text-slate-800 uppercase tracking-wider">Local Sandbox Protection</p>
             <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest leading-none">Offline Communication Only • Zero Cloud Data Leakage</p>
           </div>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="hidden md:flex flex-col items-end border-r border-slate-200 pr-6">
            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Host Environment</span>
            <span className="text-[11px] font-bold text-slate-600 font-mono">{isLocalhost ? '127.0.0.1 (Local)' : 'External Web'}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-black text-slate-300 uppercase tracking-[0.2em]">Build</span>
            <span className="bg-slate-900 text-white text-[12px] font-bold px-3 py-1 rounded-md font-mono">{LAST_UPDATED}</span>
          </div>
        </div>
      </footer>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #475569; }
      `}} />
    </div>
  );
};

export default App;
