import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

// --- Types ---

interface FrameData {
  blobUrl: string;
}

// --- Utils ---

/**
 * Extract frames from a video file.
 */
const extractFrames = async (
  videoFile: File,
  frameCount: number = 30
): Promise<string[]> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    
    if (!ctx) {
      reject("Could not get canvas context");
      return;
    }

    const fileUrl = URL.createObjectURL(videoFile);
    video.src = fileUrl;
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";

    const frames: string[] = [];
    
    video.onloadedmetadata = () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    };

    video.onloadeddata = async () => {
      const duration = video.duration;
      const safeDuration = Number.isFinite(duration) ? duration : 3; 
      const interval = safeDuration / frameCount;
      
      try {
        for (let i = 0; i < frameCount; i++) {
          const time = i * interval;
          video.currentTime = time;
          
          await new Promise<void>((seekResolve) => {
            const onSeeked = () => {
              video.removeEventListener("seeked", onSeeked);
              seekResolve();
            };
            video.addEventListener("seeked", onSeeked);
          });
          
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          
          const blob = await new Promise<Blob | null>((blobResolve) => 
            canvas.toBlob(blobResolve, "image/jpeg", 0.8)
          );
          
          if (blob) {
            frames.push(URL.createObjectURL(blob));
          }
        }
        
        URL.revokeObjectURL(fileUrl);
        resolve(frames);
      } catch (err) {
        URL.revokeObjectURL(fileUrl);
        reject(err);
      }
    };

    video.onerror = (e) => {
      URL.revokeObjectURL(fileUrl);
      reject(e);
    };
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
    setProgress(10);

    try {
      const timer = setInterval(() => {
        setProgress((p) => Math.min(p + 5, 90));
      }, 200);

      const extracted = await extractFrames(file, 45); 
      
      clearInterval(timer);
      setProgress(100);
      
      setTimeout(() => {
        setFrames(extracted);
        setIsProcessing(false);
        if (permissionGranted || !window.DeviceOrientationEvent) {
          setViewMode(true);
        }
      }, 500);
    } catch (err) {
      console.error(err);
      alert("Failed to process video. Please try a different file.");
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
                    <span className="text-[10px] font-mono text-red-500 animate-pulse pl-2.5">● LIVE FEED</span>
                </div>
                <button 
                  onClick={() => setViewMode(false)}
                  className="pointer-events-auto text-white/60 hover:text-white font-mono text-xs border border-white/20 px-3 py-1 bg-black/50 backdrop-blur-sm"
                >
                  [ CLOSE_LINK ]
                </button>
            </div>
            
            <div className="flex justify-between items-end">
                 <div className="font-mono text-[10px] text-white/30">
                    G-SENSOR: ACTIVE<br/>
                    MOIRE: 100%
                 </div>
                 {/* Tilt Indicator Visualization */}
                 <div className="w-32 h-1 bg-white/20 relative">
                    <div 
                        className="absolute top-0 bottom-0 w-1 bg-white transition-all duration-75"
                        style={{ left: `${(currentFrameIndex / frames.length) * 100}%` }}
                    />
                 </div>
            </div>
        </div>

        {/* The Image Container */}
        <div className="relative w-full h-full flex items-center justify-center">
          <img 
            src={frames[currentFrameIndex]} 
            className="absolute w-full h-full object-cover"
            alt="Lenticular frame"
            style={{ 
              imageRendering: 'pixelated' 
            }}
          />
          
          <div 
            className="absolute inset-0 pointer-events-none z-10 opacity-40 mix-blend-overlay"
            style={{
              backgroundImage: `repeating-linear-gradient(90deg, transparent 0px, transparent 1px, #000 1px, #000 3px)`
            }}
          />
           <div 
            className="absolute inset-0 pointer-events-none z-10 opacity-20 mix-blend-hard-light"
            style={{
              backgroundSize: '4px 4px',
              backgroundImage: `radial-gradient(circle, transparent 20%, #000 90%)`
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