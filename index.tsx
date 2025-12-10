import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";

// --- Utils ---

/**
 * Extract frames from a video file.
 * Resizes frames to max 1024px to save texture memory on mobile.
 */
const extractFrames = async (
  videoFile: File,
  frameCount: number = 45,
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

    video.style.position = 'fixed';
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
      // Calculate scaled dimensions to avoid massive texture memory usage
      const maxDim = 1024;
      let width = video.videoWidth;
      let height = video.videoHeight;
      
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = (height / width) * maxDim;
          width = maxDim;
        } else {
          width = (width / height) * maxDim;
          height = maxDim;
        }
      }
      
      canvas.width = Math.floor(width);
      canvas.height = Math.floor(height);
    };

    video.onloadeddata = async () => {
      const duration = video.duration || 0;
      const safeDuration = (Number.isFinite(duration) && duration > 0) ? duration : 3;
      const processDuration = Math.min(safeDuration, 5); 
      const interval = processDuration / frameCount;
      const frames: string[] = [];
      
      try {
        for (let i = 0; i < frameCount; i++) {
          const time = i * interval;
          video.currentTime = time;
          
          await new Promise<void>((seekResolve) => {
            const timeoutId = setTimeout(() => seekResolve(), 200);
            const onSeeked = () => {
              clearTimeout(timeoutId);
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
    
    video.load();
  });
};

// --- Three.js Component ---

const vertexShader = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = `
uniform sampler2D uTexture;
uniform float uTilt; // -1.0 to 1.0
uniform vec2 uResolution;

varying vec2 vUv;

void main() {
  vec2 uv = vUv;
  
  // --- 1. Barrel Distortion ---
  // Warps UVs to create that curved lens look
  vec2 centered = uv - 0.5;
  float distSq = dot(centered, centered);
  float distortionStrength = 0.15;
  vec2 distortedUV = uv + centered * (distortionStrength * distSq);

  // If we distort out of bounds, make it black
  if (distortedUV.x < 0.0 || distortedUV.x > 1.0 || distortedUV.y < 0.0 || distortedUV.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
  }

  // --- 2. Lenticular Ridges (The Moiré Source) ---
  // Create high-frequency vertical sine waves
  // We curve the phase of the wave based on Y to match the barrel distortion
  float curveCof = 0.2; 
  float curve = (uv.y - 0.5) * (uv.y - 0.5) * curveCof;
  
  float frequency = 100.0; 
  float ridgePhase = (uv.x - 0.5 + curve) * frequency;
  
  // The ridge profile (0.0 to 1.0)
  float ridge = 0.5 + 0.5 * sin(ridgePhase * 6.28);
  
  // --- 3. Refraction ---
  // Offset the texture lookup based on the ridge normal
  // This is what makes the image "shift" under the plastic
  float refractionAmt = 0.005;
  vec2 texUV = distortedUV;
  texUV.x += (ridge - 0.5) * refractionAmt;
  
  // Sample texture
  vec4 texColor = texture2D(uTexture, texUV);
  
  // --- 4. Lighting & Specular ---
  // Simulate light hitting the ridges.
  // The light position moves as we tilt the device (uTilt)
  
  float tiltOffset = uTilt * 2.5; // Amplify tilt for lighting
  
  // Specular highlight: When the ridge normal aligns with light direction
  // We approximate this by checking the phase against the tilt
  float lightPhase = ridgePhase + tiltOffset;
  float specular = pow(max(0.0, sin(lightPhase * 6.28)), 8.0);
  
  // Shadow/Occlusion in the valleys
  float occlusion = 0.8 + 0.2 * ridge;
  
  // --- 5. Composite ---
  vec3 finalColor = texColor.rgb * occlusion;
  
  // Add the plastic shine (white)
  finalColor += vec3(1.0) * specular * 0.25;
  
  // Add a subtle scanline interference for extra texture
  float interference = sin(uv.y * 300.0);
  finalColor *= (0.97 + 0.03 * interference);

  // Deep Vignette
  float vignette = 1.0 - smoothstep(0.4, 0.9, length(uv - 0.5));
  finalColor *= vignette;

  gl_FragColor = vec4(finalColor, 1.0);
}
`;

const LenticularViewer = ({ 
  frames, 
  onClose 
}: { 
  frames: string[], 
  onClose: () => void 
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const texturesRef = useRef<THREE.Texture[]>([]);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const requestRef = useRef<number>(0);
  const tiltRef = useRef<number>(0);

  // Preload textures
  useEffect(() => {
    if (!frames.length) return;
    
    const loader = new THREE.TextureLoader();
    // Clear old textures
    texturesRef.current.forEach(t => t.dispose());
    texturesRef.current = [];

    // Load all textures
    Promise.all(frames.map(src => new Promise<THREE.Texture>((resolve) => {
      loader.load(src, (tex) => {
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        resolve(tex);
      });
    }))).then(loadedTextures => {
      texturesRef.current = loadedTextures;
    });

    return () => {
      texturesRef.current.forEach(t => t.dispose());
    };
  }, [frames]);

  // Three.js Setup
  useEffect(() => {
    if (!containerRef.current) return;

    // Scene setup
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    
    const updateSize = () => {
      if (!containerRef.current) return;
      const { clientWidth, clientHeight } = containerRef.current;
      renderer.setSize(clientWidth, clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Cap pixel ratio for performance
      if (materialRef.current) {
        materialRef.current.uniforms.uResolution.value.set(clientWidth, clientHeight);
      }
    };
    
    containerRef.current.appendChild(renderer.domElement);
    updateSize();

    // Plane
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTexture: { value: null }, // Will be set in animation loop
        uTilt: { value: 0 },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) }
      }
    });
    materialRef.current = material;
    
    const plane = new THREE.Mesh(geometry, material);
    scene.add(plane);

    // Resize handler
    window.addEventListener('resize', updateSize);

    // Animation Loop
    const animate = () => {
      if (!texturesRef.current.length) {
         requestRef.current = requestAnimationFrame(animate);
         return;
      }

      // 1. Determine current frame based on tilt
      // tiltRef is updated by event listeners
      const t = tiltRef.current; // -1 to 1
      
      // Map tilt (-1 to 1) to frame index (0 to length-1)
      const normTilt = (t + 1) / 2; 
      const frameIndex = Math.min(
        texturesRef.current.length - 1,
        Math.max(0, Math.floor(normTilt * texturesRef.current.length))
      );
      
      const currentTexture = texturesRef.current[frameIndex];
      
      if (materialRef.current) {
        materialRef.current.uniforms.uTexture.value = currentTexture;
        
        // Smooth tilt damping for lighting visual only, or use raw for responsiveness?
        // Using raw tilt for the lighting uniform makes it feel snappier.
        materialRef.current.uniforms.uTilt.value = t;
      }

      renderer.render(scene, camera);
      requestRef.current = requestAnimationFrame(animate);
    };
    
    requestRef.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('resize', updateSize);
      cancelAnimationFrame(requestRef.current);
      renderer.dispose();
      geometry.dispose();
      material.dispose();
      if (containerRef.current && containerRef.current.contains(renderer.domElement)) {
        containerRef.current.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Event Listeners for Tilt/Mouse
  useEffect(() => {
    const handleOrientation = (e: DeviceOrientationEvent) => {
      const gamma = e.gamma || 0; // Left/Right tilt (-90 to 90)
      const maxTilt = 30; // Degrees needed for full sweep
      
      // Clamp and normalize to -1 ... 1
      let val = Math.max(-maxTilt, Math.min(maxTilt, gamma));
      tiltRef.current = val / maxTilt;
    };

    const handleMouseMove = (e: MouseEvent) => {
      // Map X position to -1 ... 1
      const x = e.clientX / window.innerWidth;
      tiltRef.current = (x * 2) - 1; 
    };

    window.addEventListener("deviceorientation", handleOrientation);
    window.addEventListener("mousemove", handleMouseMove);

    return () => {
      window.removeEventListener("deviceorientation", handleOrientation);
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black">
      <div ref={containerRef} className="w-full h-full" />
      
      {/* Minimal Close Button */}
      <button 
        onClick={onClose}
        className="absolute top-6 right-6 z-50 w-10 h-10 flex items-center justify-center bg-transparent opacity-50 hover:opacity-100 transition-opacity"
        aria-label="Close"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
  );
};


// --- Main App ---

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

  // --- Render ---

  // 1. Full Screen Viewer (Three.js)
  if (viewMode && frames.length > 0) {
    return <LenticularViewer frames={frames} onClose={() => setViewMode(false)} />;
  }

  // 2. Dashboard / Upload
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