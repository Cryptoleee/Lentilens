import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

// --- Types ---

interface FrameData {
  blobUrl: string;
}

// --- Utils ---

/**
 * Extract frames from a video file.
 * Attaches video to DOM temporarily to ensure mobile browsers render frames correctly.
 */
const extractFrames = async (
  videoFile: File,
  frameCount: number = 30,
  onProgress?: (percent: number) => void
): Promise<string[]> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    
    if (!ctx) {
      reject("Could not get canvas context");
      return;
    }

    // Mobile browsers require video to be in DOM and inline to seek properly
    video.style.position = 'fixed';
    video.style.top = '0';
    video.style.left = '0';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    video.muted = true;
    
    document.body.appendChild(video);

    const fileUrl = URL.createObjectURL(videoFile);
    video.src = fileUrl;
    
    const cleanup = () => {
      if (document.body.contains(video)) {
        document.body.removeChild(video);
      }
      URL.revokeObjectURL(fileUrl);
    };

    video.onerror = (e) => {
      cleanup();
      reject("Video format not supported or load error.");
    };

    video.onloadedmetadata = () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    };

    video.onloadeddata = async () => {
      // Use duration, but cap at 5 seconds to prevent huge processing times
      const duration = video.duration || 0;
      const safeDuration = (Number.isFinite(duration) && duration > 0) ? duration : 3;
      const processDuration = Math.min(safeDuration, 5); 
      const interval = processDuration / frameCount;
      const frames: string[] = [];
      
      try {
        for (let i = 0; i < frameCount; i++) {
          const time = i * interval;
          video.currentTime = time;
          
          // Wait for seek to complete with a safety timeout
          await new Promise<void>((seekResolve) => {
            const timeoutId = setTimeout(() => {
               // If seek takes too long, just proceed (might duplicate frame, better than hanging)
               seekResolve();
            }, 500);

            const onSeeked = () => {
              clearTimeout(timeoutId);
              video.removeEventListener("seeked", onSeeked);
              seekResolve();
            };
            video.addEventListener("seeked", onSeeked);
          });
          
          // Draw to canvas
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          
          // Convert to blob
          const blob = await new Promise<Blob | null>((blobResolve) => 
            canvas.toBlob(blobResolve, "image/jpeg", 0.7)
          );
          
          if (blob) {
            frames.push(URL.createObjectURL(blob));
          }

          if (onProgress) {
            onProgress(Math.round(((i + 1) / frameCount) * 100));
          }
        }
        
        cleanup();
        resolve(frames);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };
    
    // Trigger load
    video.load();
  });
};

// --- Components ---

const Separator = () => (
  <div className="w-full h-px bg-white/20 my-4" />
);

const DataLabel = ({ label, value }: { label: string, value: string }) => (
  <div className="flex flex-col gap-1">
    <span className="text-[10px] uppercase tracking-wider text-white/40 font-mono">{label}</span>
    <span className="text-sm font-mono text-white/90">{value}</span>
  </div>
);

const Clock = () => {
  const [time, setTime] = useState("");
  useEffect(() => {
    const update = () => {
      const now = new Date();
      setTime(now.toISOString().split('T')[1].split('.')[0]);
    };
    const i = setInterval(update, 1000);
    update();
    return () => clearInterval(i);
  }, []);
  return <span className="font-mono text-xs text-white/60">{time} UTC</span>;
}

const App = () => {
  const [frames, setFrames] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [viewMode, setViewMode] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState(false);
  
  // Viewer state
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);

  // --- Handlers ---

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    setProgress(0);
    setFrames([]);

    try {
      // Pass the progress updater directly to the extractor
      const extracted = await extractFrames(file, 45, (percent) => {
        setProgress(percent);
      });
      
      setFrames(extracted);
      setIsProcessing(false);
      
      // Auto-switch to view mode if possible
      setTimeout(() => {
        if (permissionGranted || !window.DeviceOrientationEvent) {
          setViewMode(true);
        }
      }, 500);

    } catch (err) {
      console.error(err);
      alert("Error processing video. Try a shorter clip or different format.");
      setIsProcessing(false);
      setProgress(0);
    }
  };

  const requestPermission = async () => {
    if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
      try {
        const response = await (DeviceOrientationEvent as any).requestPermission();
        if (response === 'granted') {
          setPermissionGranted(true);
          if (frames.length > 0) setViewMode(true);
        } else {
          alert("Motion access is required for the tilt effect.");
        }
      } catch (e) {
        console.error(e);
      }
    } else {
      setPermissionGranted(true);
      if (frames.length > 0) setViewMode(true);
    }
  };

  // --- Effects ---

  useEffect(() => {
    if (!viewMode || frames.length === 0) return;

    const handleOrientation = (e: DeviceOrientationEvent) => {
      const val = e.gamma || 0; 
      const maxTilt = 30;
      const clampedVal = Math.max(-maxTilt, Math.min(maxTilt, val));
      const normalized = (clampedVal + maxTilt) / (2 * maxTilt);
      const index = Math.min(
        frames.length - 1,
        Math.floor(normalized * frames.length)
      );
      setCurrentFrameIndex(index);
    };

    const handleMouseMove = (e: MouseEvent) => {
      const normalized = e.clientX / window.innerWidth;
      const index = Math.min(
        frames.length - 1,
        Math.floor(normalized * frames.length)
      );
      setCurrentFrameIndex(index);
    };

    window.addEventListener("deviceorientation", handleOrientation);
    window.addEventListener("mousemove", handleMouseMove);

    return () => {
      window.removeEventListener("deviceorientation", handleOrientation);
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, [viewMode, frames]);

  // --- Render: Full Screen Viewer ---

  if (viewMode && frames.length > 0) {
    return (
      <div className="fixed inset-0 bg-black overflow-hidden flex items-center justify-center">
        {/* HUD Overlay */}
        <div className="absolute inset-0 pointer-events-none z-50 p-6 flex flex-col justify-between">
            <div className="flex justify-between items-start">
                <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-mono text-white/50 border-l-2 border-white/50 pl-2">PLAYBACK_MODE</span>
                    <span className="text-[10px] font-mono text-emerald-500 animate-pulse pl-2.5">● LIVE FEED</span>
                </div>
                <button 
                  onClick={() => setViewMode(false)}
                  className="pointer-events-auto text-white/60 hover:text-white font-mono text-xs border border-white/20 px-3 py-1 bg-black/50 backdrop-blur-sm transition-colors"
                >
                  [ CLOSE_LINK ]
                </button>
            </div>
            
            <div className="flex justify-between items-end">
                 <div className="font-mono text-[10px] text-white/30">
                    G-SENSOR: ACTIVE<br/>
                    LENS_REFRACTION: 1.54
                 </div>
                 {/* Tilt Indicator Visualization */}
                 <div className="w-32 h-1 bg-white/10 relative overflow-hidden">
                    <div 
                        className="absolute top-0 bottom-0 w-full bg-gradient-to-r from-transparent via-white/40 to-transparent transform transition-transform duration-75"
                        style={{ transform: `translateX(${(currentFrameIndex / frames.length) * 100 - 50}%)` }}
                    />
                    <div 
                        className="absolute top-0 bottom-0 w-0.5 bg-white transition-all duration-75"
                        style={{ left: `${(currentFrameIndex / frames.length) * 100}%` }}
                    />
                 </div>
            </div>
        </div>

        {/* The Image Container */}
        <div className="relative w-full h-full flex items-center justify-center bg-[#050505]">
          <img 
            src={frames[currentFrameIndex]} 
            className="absolute w-full h-full object-cover transition-opacity duration-75"
            alt="Lenticular frame"
          />
          
          {/* LAYER 1: Lenticular Ridges (The physical texture) */}
          <div 
            className="absolute inset-0 pointer-events-none z-10 opacity-30 mix-blend-hard-light"
            style={{
              backgroundImage: `repeating-linear-gradient(90deg, 
                rgba(255,255,255,0.1) 0px, 
                rgba(255,255,255,0) 1px, 
                rgba(0,0,0,0.3) 2px, 
                rgba(0,0,0,0.8) 3px,
                rgba(0,0,0,0.3) 4px
              )`
            }}
          />

          {/* LAYER 2: Specular Highlight (The Gloss) */}
          <div 
            className="absolute inset-0 pointer-events-none z-20 opacity-40 mix-blend-screen"
            style={{
              background: `linear-gradient(115deg, 
                transparent 30%, 
                rgba(255,255,255,0.05) 40%, 
                rgba(255,255,255,0.3) 45%, 
                rgba(255,255,255,0.05) 50%, 
                transparent 60%
              )`
            }}
          />

           {/* LAYER 3: Deep Vignette (Depth) */}
           <div 
            className="absolute inset-0 pointer-events-none z-30 opacity-70 mix-blend-multiply"
            style={{
              background: `radial-gradient(circle at 50% 50%, transparent 20%, #000 120%)`
            }}
          />
          
          {/* LAYER 4: Subtle Noise (Tactile feel) */}
          <div className="absolute inset-0 pointer-events-none z-40 opacity-[0.03] mix-blend-overlay"
             style={{
                 backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`
             }}
          />
        </div>
      </div>
    );
  }

  // --- Render: Dashboard / Upload ---

  return (
    <div className="min-h-screen bg-black text-white flex flex-col relative p-6 font-sans">
      
      {/* Background Decorative Lines */}
      <div className="fixed inset-0 pointer-events-none border-[1px] border-white/10 m-4 rounded-sm z-0" />
      <div className="fixed top-20 bottom-32 left-6 right-6 pointer-events-none border-x border-white/5 z-0" />

      {/* Header Section */}
      <header className="relative z-10 pt-8 pb-6">
        <div className="flex justify-between items-baseline mb-8">
            <h1 className="text-4xl md:text-5xl font-mono font-bold tracking-tighter text-white">
              NEURAL<span className="font-light text-white/40">_LENS</span>
            </h1>
        </div>

        <div className="grid grid-cols-2 gap-8 mb-4">
            <DataLabel label="System" value="ONLINE" />
            <div className="flex flex-col gap-1 items-end text-right">
                 <span className="text-[10px] uppercase tracking-wider text-white/40 font-mono">Local Time</span>
                 <Clock />
            </div>
        </div>
        
        <div className="grid grid-cols-2 gap-4">
            <DataLabel label="Memory" value="128 TB" />
            <DataLabel label="Security" value="ENCRYPTED" />
        </div>
      </header>

      {/* Main Visual / Interaction Area */}
      <main className="flex-1 relative flex flex-col justify-center z-10 min-h-[400px]">
        
        {/* Center Box Decoration */}
        <div className="absolute top-0 right-0 w-4 h-4 border-t border-r border-white/40" />
        <div className="absolute top-0 left-0 w-4 h-4 border-t border-l border-white/40" />
        <div className="absolute bottom-0 right-0 w-4 h-4 border-b border-r border-white/40" />
        <div className="absolute bottom-0 left-0 w-4 h-4 border-b border-l border-white/40" />
        
        {/* Connector Lines */}
        <div className="absolute top-[50%] left-0 w-4 h-px bg-white/30" />
        <div className="absolute top-[50%] right-0 w-4 h-px bg-white/30" />
        <div className="absolute top-0 left-[50%] w-px h-4 bg-white/30" />
        <div className="absolute bottom-0 left-[50%] w-px h-4 bg-white/30" />

        {/* Content */}
        <div className="w-full h-full flex flex-col items-center justify-center bg-white/5 border border-white/5 relative overflow-hidden backdrop-blur-sm">
             <div className="scanline" />
             
             {isProcessing ? (
               <div className="w-full max-w-[200px] font-mono text-xs">
                 <div className="flex justify-between mb-1 text-white/70">
                   <span>DECODING_MATRIX</span>
                   <span>{progress}%</span>
                 </div>
                 <div className="w-full h-1 bg-white/10">
                   <div 
                     className="h-full bg-white transition-all duration-100 ease-linear"
                     style={{ width: `${progress}%` }} 
                   />
                 </div>
                 <div className="mt-4 text-center text-white/30 animate-pulse">
                   PLEASE WAIT...
                 </div>
               </div>
             ) : frames.length > 0 ? (
               <div className="flex flex-col items-center">
                  <div className="text-4xl mb-4 opacity-80">✓</div>
                  <div className="font-mono text-sm tracking-widest mb-6">SEQUENCE_READY</div>
               </div>
             ) : (
               <div className="text-center opacity-40 hover:opacity-100 transition-opacity duration-500">
                  <div className="w-20 h-20 border border-dashed border-white/40 mx-auto mb-4 rounded-full flex items-center justify-center">
                    <div className="w-2 h-2 bg-white/60 rounded-full" />
                  </div>
                  <p className="font-mono text-xs tracking-widest">AWAITING_INPUT</p>
               </div>
             )}
        </div>
      </main>

      {/* Footer / Navigation Bar */}
      <footer className="relative z-10 pt-6 pb-4">
        <div className="flex flex-col gap-4">
            
            <div className="flex justify-between items-center text-[10px] font-mono text-white/30 px-2">
                <span>V.2.04</span>
                <span>COPYRIGHT_2025</span>
            </div>

            {/* Main Action Button */}
            {frames.length > 0 && !isProcessing ? (
               !permissionGranted && typeof (DeviceOrientationEvent as any)?.requestPermission === 'function' ? (
                  <button 
                    onClick={requestPermission}
                    className="w-full py-6 bg-white text-black font-mono font-bold tracking-widest hover:bg-neutral-200 transition-colors uppercase flex justify-between px-8 items-center group"
                  >
                    <span>&lt; Grant_Access</span>
                    <span className="group-hover:translate-x-1 transition-transform">&gt;</span>
                  </button>
               ) : (
                  <button 
                    onClick={() => setViewMode(true)}
                    className="w-full py-6 bg-white text-black font-mono font-bold tracking-widest hover:bg-neutral-200 transition-colors uppercase flex justify-between px-8 items-center group"
                  >
                    <span>&lt; Initialize_View</span>
                    <span className="group-hover:translate-x-1 transition-transform">&gt;</span>
                  </button>
               )
            ) : (
               <label className={`w-full py-6 border border-white/20 hover:bg-white hover:text-black transition-all cursor-pointer font-mono font-bold tracking-widest uppercase flex justify-between px-8 items-center group ${isProcessing ? 'opacity-50 pointer-events-none' : ''}`}>
                 <span>&lt; Upload_Clip</span>
                 <span className="group-hover:translate-x-1 transition-transform text-white/0 group-hover:text-black">&gt;</span>
                 <input 
                   type="file" 
                   accept="video/*" 
                   onChange={handleFileSelect} 
                   className="hidden" 
                   disabled={isProcessing}
                 />
               </label>
            )}
        </div>
      </footer>
    </div>
  );
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);