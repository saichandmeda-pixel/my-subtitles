import { useState, useRef, useEffect, useCallback } from "react";

// SRT Parser
function parseSRT(content) {
  const blocks = content.trim().split(/\n\s*\n/);
  return blocks.map(block => {
    const lines = block.trim().split('\n');
    if (lines.length < 3) return null;
    const timeLine = lines[1];
    const match = timeLine.match(
      /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
    );
    if (!match) return null;
    const toMs = (h, m, s, ms) => (+h * 3600 + +m * 60 + +s) * 1000 + +ms;
    return {
      start: toMs(match[1], match[2], match[3], match[4]),
      end: toMs(match[5], match[6], match[7], match[8]),
      text: lines.slice(2).join('\n').replace(/<[^>]+>/g, '')
    };
  }).filter(Boolean);
}

// Parse WebVTT
function parseVTT(content) {
  const cleaned = content.replace(/^WEBVTT.*\n/, '').trim();
  return parseSRT(cleaned.replace(/\./g, ','));
}

function getActiveSubtitle(subtitles, timeMs) {
  return subtitles.find(s => timeMs >= s.start && timeMs <= s.end) || null;
}

const FONTS = [
  { label: 'Bebas Neue', value: "'Bebas Neue', cursive" },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Courier New', value: "'Courier New', monospace" },
  { label: 'Trebuchet MS', value: "'Trebuchet MS', sans-serif" },
  { label: 'Impact', value: 'Impact, sans-serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
];

const POSITIONS = [
  { label: 'Bottom', value: 'bottom' },
  { label: 'Center', value: 'center' },
  { label: 'Top', value: 'top' },
];

export default function SubtitleBurner() {
  const [videoSrc, setVideoSrc] = useState(null);
  const [subtitles, setSubtitles] = useState([]);
  const [subtitleFile, setSubtitleFile] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportDone, setExportDone] = useState(false);
  const [exportUrl, setExportUrl] = useState(null);
  const [currentSub, setCurrentSub] = useState(null);
  const [dragOver, setDragOver] = useState(null);

  const [style, setStyle] = useState({
    fontFamily: "'Bebas Neue', cursive",
    fontSize: 32,
    color: '#ffffff',
    bgColor: 'rgba(0,0,0,0.55)',
    bgEnabled: true,
    stroke: false,
    strokeColor: '#000000',
    position: 'bottom',
    bold: false,
    italic: false,
  });

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);

  // Draw frame with subtitle
  const drawFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 360;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const timeMs = video.currentTime * 1000;
    const sub = getActiveSubtitle(subtitles, timeMs);
    setCurrentSub(sub?.text || null);

    if (sub) {
      const lines = sub.text.split('\n');
      const fs = style.fontSize * (canvas.width / 640);
      const fontStr = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${fs}px ${style.fontFamily}`;
      ctx.font = fontStr;
      ctx.textAlign = 'center';

      const lineH = fs * 1.3;
      const totalH = lineH * lines.length;
      const padX = fs * 0.6;
      const padY = fs * 0.35;

      const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
      const bgW = maxW + padX * 2;
      const bgH = totalH + padY * 2;

      let yBase;
      if (style.position === 'bottom') yBase = canvas.height - bgH - fs * 0.5;
      else if (style.position === 'top') yBase = fs * 0.5;
      else yBase = (canvas.height - bgH) / 2;

      if (style.bgEnabled) {
        ctx.fillStyle = style.bgColor;
        const rx = (canvas.width - bgW) / 2;
        const ry = yBase;
        const r = fs * 0.2;
        ctx.beginPath();
        ctx.moveTo(rx + r, ry);
        ctx.lineTo(rx + bgW - r, ry);
        ctx.quadraticCurveTo(rx + bgW, ry, rx + bgW, ry + r);
        ctx.lineTo(rx + bgW, ry + bgH - r);
        ctx.quadraticCurveTo(rx + bgW, ry + bgH, rx + bgW - r, ry + bgH);
        ctx.lineTo(rx + r, ry + bgH);
        ctx.quadraticCurveTo(rx, ry + bgH, rx, ry + bgH - r);
        ctx.lineTo(rx, ry + r);
        ctx.quadraticCurveTo(rx, ry, rx + r, ry);
        ctx.closePath();
        ctx.fill();
      }

      lines.forEach((line, i) => {
        const x = canvas.width / 2;
        const y = yBase + padY + fs + i * lineH;
        ctx.font = fontStr;
        if (style.stroke) {
          ctx.strokeStyle = style.strokeColor;
          ctx.lineWidth = fs * 0.08;
          ctx.strokeText(line, x, y);
        }
        ctx.fillStyle = style.color;
        ctx.fillText(line, x, y);
      });
    }

    animRef.current = requestAnimationFrame(drawFrame);
  }, [subtitles, style]);

  useEffect(() => {
    if (videoSrc) {
      cancelAnimationFrame(animRef.current);
      animRef.current = requestAnimationFrame(drawFrame);
    }
    return () => cancelAnimationFrame(animRef.current);
  }, [videoSrc, drawFrame]);

  const handleVideoUpload = (file) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setExportDone(false);
    setExportUrl(null);
  };

  const handleSubtitleUpload = (file) => {
    if (!file) return;
    setSubtitleFile(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target.result;
      const parsed = file.name.endsWith('.vtt') ? parseVTT(content) : parseSRT(content);
      setSubtitles(parsed);
    };
    reader.readAsText(file);
  };

  const startExport = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    setExporting(true);
    setExportProgress(0);
    setExportDone(false);
    chunksRef.current = [];

    const stream = canvas.captureStream(30);
    // Try to add audio
    try {
      const audioCtx = new AudioContext();
      const src = audioCtx.createMediaElementSource(video);
      const dest = audioCtx.createMediaStreamDestination();
      src.connect(dest);
      src.connect(audioCtx.destination);
      dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    } catch (e) {}

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm';
    const mr = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 });
    mediaRecorderRef.current = mr;

    mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      setExportUrl(url);
      setExporting(false);
      setExportDone(true);
    };

    video.currentTime = 0;
    video.onplay = null;
    setTimeout(() => {
      mr.start(100);
      video.play();

      const dur = video.duration;
      const interval = setInterval(() => {
        setExportProgress(Math.min(99, Math.round((video.currentTime / dur) * 100)));
      }, 500);

      video.onended = () => {
        clearInterval(interval);
        setExportProgress(100);
        mr.stop();
        video.onended = null;
      };
    }, 300);
  };

  const S = style;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0d0d0f; }

        .app {
          min-height: 100vh;
          background: #0d0d0f;
          color: #e8e4dc;
          font-family: 'DM Sans', sans-serif;
          padding: 24px;
          display: grid;
          grid-template-columns: 1fr 340px;
          gap: 20px;
          max-width: 1200px;
          margin: 0 auto;
        }

        .app-header {
          grid-column: 1 / -1;
          display: flex;
          align-items: baseline;
          gap: 12px;
          margin-bottom: 4px;
        }

        .app-title {
          font-family: 'Bebas Neue', cursive;
          font-size: 42px;
          letter-spacing: 3px;
          color: #e8e4dc;
          line-height: 1;
        }

        .app-sub {
          font-size: 13px;
          color: #555;
          font-family: 'DM Mono', monospace;
          letter-spacing: 1px;
        }

        .main-col { display: flex; flex-direction: column; gap: 16px; }
        .side-col { display: flex; flex-direction: column; gap: 12px; }

        /* Upload zones */
        .upload-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

        .drop-zone {
          border: 1.5px dashed #2a2a30;
          border-radius: 10px;
          padding: 22px 16px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          cursor: pointer;
          transition: all 0.2s;
          background: #111115;
          position: relative;
          overflow: hidden;
        }
        .drop-zone:hover, .drop-zone.active {
          border-color: #e8973a;
          background: #15140f;
        }
        .drop-zone input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
        .drop-zone .icon { font-size: 24px; opacity: 0.5; }
        .drop-zone .label { font-size: 12px; color: #777; font-family: 'DM Mono', monospace; }
        .drop-zone .fname { font-size: 12px; color: #e8973a; font-family: 'DM Mono', monospace; text-align: center; }
        .drop-zone.filled { border-color: #2d3a1f; background: #111510; }
        .drop-zone.filled .icon { opacity: 1; }

        /* Video preview */
        .preview-wrap {
          background: #080809;
          border-radius: 12px;
          overflow: hidden;
          position: relative;
          border: 1px solid #1a1a1f;
          aspect-ratio: 16/9;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .preview-wrap video { display: none; }
        .preview-wrap canvas {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }
        .no-video {
          color: #333;
          font-family: 'DM Mono', monospace;
          font-size: 13px;
          letter-spacing: 1px;
          text-align: center;
        }

        /* Controls card */
        .card {
          background: #111115;
          border: 1px solid #1e1e24;
          border-radius: 12px;
          padding: 16px;
        }
        .card-title {
          font-family: 'Bebas Neue', cursive;
          font-size: 18px;
          letter-spacing: 2px;
          color: #888;
          margin-bottom: 14px;
        }

        .ctrl-row { display: flex; flex-direction: column; gap: 10px; }
        .ctrl-item { display: flex; flex-direction: column; gap: 5px; }
        .ctrl-label {
          font-size: 10px;
          font-family: 'DM Mono', monospace;
          letter-spacing: 1.5px;
          color: #555;
          text-transform: uppercase;
        }

        select, input[type="range"] {
          width: 100%;
          background: #0d0d0f;
          border: 1px solid #2a2a30;
          border-radius: 6px;
          color: #e8e4dc;
          padding: 7px 10px;
          font-size: 13px;
          font-family: 'DM Mono', monospace;
          outline: none;
          appearance: none;
          transition: border-color 0.2s;
        }
        select:focus, input[type="text"]:focus { border-color: #e8973a; }

        input[type="range"] {
          padding: 0;
          height: 4px;
          cursor: pointer;
          accent-color: #e8973a;
        }

        .color-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .color-item { display: flex; flex-direction: column; gap: 5px; }
        .color-picker-wrap {
          display: flex;
          align-items: center;
          gap: 8px;
          background: #0d0d0f;
          border: 1px solid #2a2a30;
          border-radius: 6px;
          padding: 5px 8px;
        }
        .color-picker-wrap input[type="color"] {
          width: 22px; height: 22px;
          padding: 0; border: none;
          background: none;
          cursor: pointer;
          border-radius: 3px;
        }
        .color-picker-wrap span {
          font-size: 11px;
          font-family: 'DM Mono', monospace;
          color: #777;
        }

        .toggle-row { display: flex; gap: 8px; }
        .toggle-btn {
          flex: 1;
          background: #0d0d0f;
          border: 1px solid #2a2a30;
          border-radius: 6px;
          color: #777;
          font-size: 11px;
          font-family: 'DM Mono', monospace;
          padding: 6px;
          cursor: pointer;
          letter-spacing: 0.5px;
          transition: all 0.15s;
          text-align: center;
        }
        .toggle-btn.on {
          background: #1a1508;
          border-color: #e8973a;
          color: #e8973a;
        }

        .pos-row { display: flex; gap: 6px; }
        .pos-btn {
          flex: 1;
          background: #0d0d0f;
          border: 1px solid #2a2a30;
          border-radius: 6px;
          color: #777;
          font-size: 11px;
          font-family: 'DM Mono', monospace;
          padding: 7px 4px;
          cursor: pointer;
          transition: all 0.15s;
          text-align: center;
        }
        .pos-btn.on { background: #1a1508; border-color: #e8973a; color: #e8973a; }

        .sub-preview {
          background: #080808;
          border-radius: 8px;
          padding: 12px;
          min-height: 44px;
          font-size: 12px;
          font-family: 'DM Mono', monospace;
          color: #444;
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          border: 1px solid #1a1a1f;
        }
        .sub-active {
          color: #e8e4dc;
          font-size: 13px;
          font-family: inherit;
        }

        /* Export */
        .export-btn {
          width: 100%;
          background: linear-gradient(135deg, #e8973a 0%, #d4762a 100%);
          color: #0d0d0f;
          border: none;
          border-radius: 8px;
          padding: 14px;
          font-family: 'Bebas Neue', cursive;
          font-size: 20px;
          letter-spacing: 2px;
          cursor: pointer;
          transition: all 0.2s;
          position: relative;
          overflow: hidden;
        }
        .export-btn:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(232,151,58,0.25); }
        .export-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

        .progress-bar {
          height: 3px;
          background: #1a1a1f;
          border-radius: 2px;
          overflow: hidden;
          margin-top: 8px;
        }
        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #e8973a, #f0b060);
          border-radius: 2px;
          transition: width 0.3s;
        }

        .download-btn {
          display: block;
          width: 100%;
          background: #1a2a14;
          border: 1px solid #3d6b2a;
          color: #7dbe52;
          border-radius: 8px;
          padding: 12px;
          text-align: center;
          text-decoration: none;
          font-family: 'Bebas Neue', cursive;
          font-size: 18px;
          letter-spacing: 2px;
          transition: all 0.2s;
        }
        .download-btn:hover { background: #1f3318; }

        .info-chip {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          background: #1a1508;
          border: 1px solid #3a2e14;
          border-radius: 100px;
          padding: 4px 10px;
          font-size: 11px;
          font-family: 'DM Mono', monospace;
          color: #e8973a;
        }

        .range-val {
          font-size: 11px;
          font-family: 'DM Mono', monospace;
          color: #e8973a;
          text-align: right;
        }

        @media (max-width: 768px) {
          .app { grid-template-columns: 1fr; padding: 16px; }
        }
      `}</style>

      <div className="app">
        <div className="app-header">
          <h1 className="app-title">SubtitleBurner</h1>
          <span className="app-sub">// burn subtitles into video</span>
        </div>

        {/* Main column */}
        <div className="main-col">
          {/* Upload row */}
          <div className="upload-row">
            <label
              className={`drop-zone ${videoSrc ? 'filled' : ''} ${dragOver === 'video' ? 'active' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragOver('video'); }}
              onDragLeave={() => setDragOver(null)}
              onDrop={e => { e.preventDefault(); setDragOver(null); handleVideoUpload(e.dataTransfer.files[0]); }}
            >
              <input type="file" accept="video/*" onChange={e => handleVideoUpload(e.target.files[0])} />
              <div className="icon">{videoSrc ? '🎬' : '📹'}</div>
              <div className="label">{videoSrc ? 'VIDEO LOADED' : 'DROP VIDEO FILE'}</div>
              {videoSrc && <div className="fname">click to replace</div>}
            </label>

            <label
              className={`drop-zone ${subtitles.length > 0 ? 'filled' : ''} ${dragOver === 'sub' ? 'active' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragOver('sub'); }}
              onDragLeave={() => setDragOver(null)}
              onDrop={e => { e.preventDefault(); setDragOver(null); handleSubtitleUpload(e.dataTransfer.files[0]); }}
            >
              <input type="file" accept=".srt,.vtt" onChange={e => handleSubtitleUpload(e.target.files[0])} />
              <div className="icon">{subtitles.length > 0 ? '📝' : '💬'}</div>
              <div className="label">{subtitles.length > 0 ? `${subtitles.length} CUES LOADED` : 'DROP .SRT / .VTT'}</div>
              {subtitleFile && <div className="fname">{subtitleFile}</div>}
            </label>
          </div>

          {/* Video preview */}
          <div className="preview-wrap">
            {videoSrc ? (
              <>
                <video
                  ref={videoRef}
                  src={videoSrc}
                  controls
                  style={{ display: 'block', width: '1px', height: '1px', position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                  crossOrigin="anonymous"
                />
                <canvas ref={canvasRef} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                {/* Controls overlay */}
                <div style={{
                  position: 'absolute', bottom: 0, left: 0, right: 0,
                  background: 'linear-gradient(transparent, rgba(0,0,0,0.9))',
                  padding: '30px 16px 12px',
                  display: 'flex', alignItems: 'center', gap: 8
                }}>
                  <button onClick={() => videoRef.current?.paused ? videoRef.current.play() : videoRef.current.pause()}
                    style={{ background: '#e8973a', border: 'none', borderRadius: '50%', width: 36, height: 36, cursor: 'pointer', fontSize: 14 }}>
                    ▶
                  </button>
                  <div style={{ flex: 1, height: 3, background: '#333', borderRadius: 2, cursor: 'pointer' }}
                    onClick={e => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const ratio = (e.clientX - rect.left) / rect.width;
                      if (videoRef.current) videoRef.current.currentTime = ratio * videoRef.current.duration;
                    }}>
                    <div style={{ height: '100%', background: '#e8973a', width: videoRef.current ? `${(videoRef.current.currentTime / videoRef.current.duration) * 100}%` : '0%', borderRadius: 2 }} />
                  </div>
                </div>
              </>
            ) : (
              <div className="no-video">// upload a video to preview</div>
            )}
          </div>

          {/* Current subtitle */}
          <div className="sub-preview">
            {currentSub
              ? <span className="sub-active" style={{
                  fontFamily: S.fontFamily,
                  fontSize: Math.max(14, S.fontSize * 0.5),
                  color: S.color,
                  fontWeight: S.bold ? 'bold' : 'normal',
                  fontStyle: S.italic ? 'italic' : 'normal',
                  textShadow: S.stroke ? `0 0 3px ${S.strokeColor}` : 'none',
                }}>{currentSub}</span>
              : '// subtitle preview area'
            }
          </div>

          {/* Export */}
          {exporting && (
            <div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${exportProgress}%` }} />
              </div>
              <div style={{ textAlign: 'center', marginTop: 6, fontSize: 11, fontFamily: "'DM Mono', monospace", color: '#777' }}>
                ENCODING... {exportProgress}%
              </div>
            </div>
          )}
          {exportDone && exportUrl && (
            <a className="download-btn" href={exportUrl} download="subtitled-video.webm">
              ↓ DOWNLOAD VIDEO
            </a>
          )}
          <button
            className="export-btn"
            onClick={startExport}
            disabled={!videoSrc || exporting}
          >
            {exporting ? `ENCODING ${exportProgress}%...` : 'BURN & EXPORT VIDEO'}
          </button>
        </div>

        {/* Side column - style controls */}
        <div className="side-col">
          <div className="card">
            <div className="card-title">Typography</div>
            <div className="ctrl-row">
              <div className="ctrl-item">
                <span className="ctrl-label">Font Family</span>
                <select value={S.fontFamily} onChange={e => setStyle(s => ({ ...s, fontFamily: e.target.value }))}>
                  {FONTS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </div>
              <div className="ctrl-item">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="ctrl-label">Font Size</span>
                  <span className="range-val">{S.fontSize}px</span>
                </div>
                <input type="range" min="14" max="72" value={S.fontSize}
                  onChange={e => setStyle(s => ({ ...s, fontSize: +e.target.value }))} />
              </div>
              <div className="ctrl-item">
                <span className="ctrl-label">Style</span>
                <div className="toggle-row">
                  <button className={`toggle-btn ${S.bold ? 'on' : ''}`}
                    onClick={() => setStyle(s => ({ ...s, bold: !s.bold }))}>BOLD</button>
                  <button className={`toggle-btn ${S.italic ? 'on' : ''}`}
                    onClick={() => setStyle(s => ({ ...s, italic: !s.italic }))}>ITALIC</button>
                  <button className={`toggle-btn ${S.stroke ? 'on' : ''}`}
                    onClick={() => setStyle(s => ({ ...s, stroke: !s.stroke }))}>OUTLINE</button>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-title">Colors</div>
            <div className="color-row">
              <div className="color-item">
                <span className="ctrl-label">Text Color</span>
                <div className="color-picker-wrap">
                  <input type="color" value={S.color}
                    onChange={e => setStyle(s => ({ ...s, color: e.target.value }))} />
                  <span>{S.color}</span>
                </div>
              </div>
              {S.stroke && (
                <div className="color-item">
                  <span className="ctrl-label">Outline Color</span>
                  <div className="color-picker-wrap">
                    <input type="color" value={S.strokeColor}
                      onChange={e => setStyle(s => ({ ...s, strokeColor: e.target.value }))} />
                    <span>{S.strokeColor}</span>
                  </div>
                </div>
              )}
            </div>
            <div style={{ marginTop: 10 }}>
              <div className="ctrl-item">
                <span className="ctrl-label">Background</span>
                <div className="toggle-row" style={{ marginBottom: S.bgEnabled ? 8 : 0 }}>
                  <button className={`toggle-btn ${S.bgEnabled ? 'on' : ''}`}
                    onClick={() => setStyle(s => ({ ...s, bgEnabled: !s.bgEnabled }))}>
                    {S.bgEnabled ? 'ON' : 'OFF'}
                  </button>
                </div>
              </div>
              {S.bgEnabled && (
                <div style={{ marginTop: 8 }}>
                  <div className="color-picker-wrap">
                    <input type="color" value={S.bgColor.replace(/rgba?\(.*/, '#000000').includes('#') ? S.bgColor : '#000000'}
                      onChange={e => {
                        const hex = e.target.value;
                        const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
                        setStyle(s => ({ ...s, bgColor: `rgba(${r},${g},${b},0.6)` }));
                      }} />
                    <span>Background</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-title">Position</div>
            <div className="pos-row">
              {POSITIONS.map(p => (
                <button key={p.value} className={`pos-btn ${S.position === p.value ? 'on' : ''}`}
                  onClick={() => setStyle(s => ({ ...s, position: p.value }))}>
                  {p.label.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-title">Info</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: '#555', lineHeight: 1.7 }}>
                Supports .srt and .vtt subtitle files. Export renders to WebM (VP9). Audio is preserved when possible. Processing happens entirely in your browser.
              </span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span className="info-chip">🔒 Local</span>
                <span className="info-chip">🎞 WebM out</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
