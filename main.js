import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';

class WebBlend {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.orbit = null;
        this.transformControl = null;
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        
        this.lights = {};
        this.objects = []; 
        this.activeObject = null;  
        this.clipboard = null;
        
        this.currentMode = 'object'; 
        this.isSculpting = false;
        this.brushRadius = 1.0;
        this.brushStrength = 0.4;
        this.brushType = 'sculpt-draw';

        // Camera View Mode State
        this.isViewingThroughCamera = false;
        this.activeCamera = null;
        this.activeSceneCamera = null; // References the camera group assigned with (🎥 ACTIVE) status

        // Timeline & Animation State
        this.currentFrame = 0;
        this.startFrame = 0;
        this.endFrame = 250;
        this.isPlaying = false;
        this.lastPlaybackTime = 0;
        this.isAutoKeyActive = false;

        // History Stacks
        this.undoStack = [];
        this.redoStack = [];
        this.maxHistory = 30;
        this.sculptStartPositions = null;
        this.transformStartState = null;

        this.notificationTimeout = null;

        // Safe Load Prefs
        let savedPrefs = null;
        try {
            savedPrefs = JSON.parse(localStorage.getItem('wb_prefs'));
        } catch (e) {
            console.warn("Could not parse saved preferences:", e);
        }
        this.prefs = savedPrefs || {
            compactMode: false,
            opacity: 1.0,
            fontSize: 11,
            renderCameraSource: 'active_scene_camera',
            gridSize: 20,
            gridDivisions: 20,
            gridMainColor: '#444444',
            gridSubColor: '#222222',
            gridOpacity: 0.5,
            gridThickness: 'normal',
            infiniteGrid: true
        };

        this.init();
    }

    init() {
        const container = document.getElementById('viewport');
        if (!container) throw new Error('Viewport element not found');

        let w = container.clientWidth || 800;
        let h = container.clientHeight || 600;
        if (w < 10) w = 800;
        if (h < 10) h = 600;

        this.scene = new THREE.Scene();
        this.scene.name = "Scene Root";

        this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 1000);
        this.camera.position.set(0, 2, 8);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance", preserveDrawingBuffer: true });
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        container.appendChild(this.renderer.domElement);

        const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
        this.scene.environment = pmremGenerator.fromScene(new RoomEnvironment(this.renderer), 0.04).texture;

        // Lighting System
        this.lights.ambient = new THREE.AmbientLight(0xffffff, 0.4);
        this.scene.add(this.lights.ambient);
        
        this.lights.directional = new THREE.DirectionalLight(0xffeedd, 2.0);
        this.lights.directional.position.set(5, 5, 5);
        this.lights.directional.castShadow = true;
        this.lights.directional.shadow.mapSize.width = 1024;
        this.lights.directional.shadow.mapSize.height = 1024;
        this.scene.add(this.lights.directional);
        
        this.lights.fill = new THREE.DirectionalLight(0xaaccff, 1.0);
        this.lights.fill.position.set(-5, 0, -5);
        this.scene.add(this.lights.fill);

        // Helpers (Built via customized grid loader)
        this.updateGridHelper();

        this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
        this.orbit.enableDamping = true;
        this.orbit.dampingFactor = 0.05;

        this.transformControl = new TransformControls(this.camera, this.renderer.domElement);
        this.transformControl.addEventListener('dragging-changed', (event) => { 
            this.orbit.enabled = !event.value;
            if (this.activeObject) {
                if (event.value) {
                    this.transformStartState = {
                        position: this.activeObject.position.clone(),
                        rotation: this.activeObject.rotation.clone(),
                        scale: this.activeObject.scale.clone()
                    };
                } else {
                    if (this.transformStartState) {
                        this.pushHistory({
                            type: 'transform',
                            uuid: this.activeObject.uuid,
                            before: this.transformStartState,
                            after: {
                                position: this.activeObject.position.clone(),
                                rotation: this.activeObject.rotation.clone(),
                                scale: this.activeObject.scale.clone()
                            }
                        });
                        this.transformStartState = null;

                        // 🔴 Auto Key triggered on drag release
                        if (this.isAutoKeyActive) {
                            this.recordTransformKeyframe(this.activeObject);
                        }
                    }
                }
            }
        });
        this.transformControl.addEventListener('change', () => this.updateTransformUI());
        // Hide the transformer elements from outliner list checks
        this.transformControl.userData.isHelper = true;
        this.scene.add(this.transformControl);

        window.addEventListener('resize', () => this.onWindowResize());
        container.addEventListener('pointerdown', (e) => this.onPointerDown(e));
        container.addEventListener('pointermove', (e) => this.onPointerMove(e));
        container.addEventListener('pointerup', () => this.onPointerUp());
        
        this.applyPreferences();
        this.setupUI();
        this.setupShortcuts();
        this.setupTimelineResizer(); // 📐 Initialize the timeline vertical resizer

        // Default starting elements
        this.addPrimitive('sphere');
        this.addCameraObject("Scene Camera");

        document.getElementById('loading').style.display = 'none';
        this.updateUIMode();

        this.renderer.setAnimationLoop(() => this.render());
    }

    applyPreferences() {
        document.documentElement.style.setProperty('--font-size', `${this.prefs.fontSize}px`);
        document.documentElement.style.setProperty('--panel-opacity', this.prefs.opacity);
        document.documentElement.style.setProperty('--padding-scale', this.prefs.compactMode ? '5px' : '10px');
        this.updateGridHelper();
    }

    savePreferences() {
        localStorage.setItem('wb_prefs', JSON.stringify(this.prefs));
        this.applyPreferences();
    }

    showNotification(text) {
        const el = document.getElementById('viewport-banner');
        if (!el) return;
        el.textContent = text;
        el.classList.remove('hidden');
        if (this.notificationTimeout) clearTimeout(this.notificationTimeout);
        this.notificationTimeout = setTimeout(() => {
            el.classList.add('hidden');
        }, 3000);
    }

    // --- 📐 TIMELINE NS DRAG-RESIZER ---
    setupTimelineResizer() {
        const resizer = document.getElementById('timeline-resizer');
        const timeline = document.getElementById('timeline-dock');
        if (!resizer || !timeline) return;

        let startY, startHeight;

        const onPointerDown = (e) => {
            startY = e.clientY;
            startHeight = timeline.offsetHeight;
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            e.preventDefault();
        };

        const onPointerMove = (e) => {
            const deltaY = startY - e.clientY; // Dragging upwards increases timeline height
            const newHeight = Math.max(50, Math.min(startHeight + deltaY, 400));
            timeline.style.height = `${newHeight}px`;
            
            // Force viewport canvas size refresh during resize drags
            this.onWindowResize();
        };

        const onPointerUp = () => {
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
        };

        resizer.addEventListener('pointerdown', onPointerDown);
    }

    // --- 🌐 GRID CUSTOMIZATION SYSTEM ---
    updateGridHelper() {
        if (this.grid) this.scene.remove(this.grid);

        const size = parseInt(this.prefs.gridSize) || 20;
        const divisions = parseInt(this.prefs.gridDivisions) || 20;
        const mainColor = this.prefs.gridMainColor || '#444444';
        const subColor = this.prefs.gridSubColor || '#222222';

        this.grid = new THREE.GridHelper(size, divisions, mainColor, subColor);
        this.grid.position.y = -0.01;
        this.grid.userData.isHelper = true;

        this.grid.material.transparent = true;
        this.grid.material.opacity = parseFloat(this.prefs.gridOpacity) !== undefined ? parseFloat(this.prefs.gridOpacity) : 0.5;

        // Apply thickness tweaks
        const thickness = this.prefs.gridThickness || 'normal';
        if (thickness === 'thick') {
            this.grid.material.linewidth = 2;
        } else if (thickness === 'thin') {
            this.grid.material.linewidth = 0.5;
        } else {
            this.grid.material.linewidth = 1;
        }

        this.scene.add(this.grid);
    }

    // --- 🎭 SKELETAL ARMATURE CREATOR ---
    createArmature(name = "Skeleton") {
        const armatureGroup = new THREE.Group();
        armatureGroup.name = name;
        armatureGroup.userData.isArmature = true;

        // Root bone creation
        const rootBone = new THREE.Bone();
        rootBone.name = "Root_Bone";
        rootBone.position.set(0, 0, 0);
        armatureGroup.add(rootBone);

        // Child joint bone
        const jointBone = new THREE.Bone();
        jointBone.name = "Joint_Bone";
        jointBone.position.set(0, 1.5, 0);
        rootBone.add(jointBone);

        // Attach visual cone helpers so users can raycast and select bones directly inside the viewport
        const armatureHelper = new THREE.SkeletonHelper(armatureGroup);
        armatureHelper.userData.isHelper = true;
        this.scene.add(armatureHelper);

        // Map bone helpers recursively
        this.addBoneVisualizer(rootBone);
        this.addBoneVisualizer(jointBone);

        this.scene.add(armatureGroup);
        this.objects.push(armatureGroup);
        this.objects.push(rootBone);
        this.objects.push(jointBone);

        this.pushHistory({
            type: 'create',
            uuid: armatureGroup.uuid,
            before: null,
            after: armatureGroup
        });

        this.selectObject(rootBone);
        this.updateOutliner();
    }

    addBoneVisualizer(bone) {
        const boneGeom = new THREE.ConeGeometry(0.12, 1.2, 4);
        boneGeom.translate(0, 0.6, 0); 
        boneGeom.rotateX(Math.PI / 2); 
        const boneMat = new THREE.MeshStandardMaterial({ 
            color: 0x90caf9, 
            wireframe: true, 
            depthTest: false,
            transparent: true,
            opacity: 0.8
        });
        const boneMesh = new THREE.Mesh(boneGeom, boneMat);
        boneMesh.userData.isBoneMesh = true;
        boneMesh.userData.bone = bone;
        bone.add(boneMesh);
        bone.userData.visualizer = boneMesh;
    }

    // --- ⏱️ TIMELINE CONTROL DOCK AND AUTO KEY WRITER ---
    updateFrame(frame) {
        this.currentFrame = Math.max(this.startFrame, Math.min(frame, this.endFrame));
        document.getElementById('anim-current-frame').value = this.currentFrame;
        document.getElementById('timeline-slider').value = this.currentFrame;

        // Scrub visual positions to current frame transformations
        this.scrubAnimation();
    }

    scrubAnimation() {
        this.objects.forEach(obj => {
            this.applyInterpolatedKeyframes(obj);
        });
        this.updateTransformUI();
        this.updateMaterialUI();
    }

    recordTransformKeyframe(obj) {
        if (!obj) return;
        obj.userData.animationTracks = obj.userData.animationTracks || {
            location: {},
            rotation: {},
            scale: {}
        };

        const frame = this.currentFrame;
        
        // Write or overwrite exact active keyframe
        obj.userData.animationTracks.location[frame] = obj.position.toArray();
        obj.userData.animationTracks.rotation[frame] = [obj.rotation.x, obj.rotation.y, obj.rotation.z];
        obj.userData.animationTracks.scale[frame] = obj.scale.toArray();

        this.updateTimelineVisuals();
        this.flashTimelineDiamond(frame);
    }

    recordMaterialKeyframe(obj) {
        if (!obj || !obj.material) return;
        obj.userData.animationTracks = obj.userData.animationTracks || {};
        obj.userData.animationTracks.material = obj.userData.animationTracks.material || {};

        const frame = this.currentFrame;
        const mat = obj.material;

        obj.userData.animationTracks.material[frame] = {
            color: mat.color ? mat.color.getHex() : 0xffffff,
            roughness: mat.roughness !== undefined ? mat.roughness : 0.5,
            opacity: mat.opacity !== undefined ? mat.opacity : 1.0
        };

        this.updateTimelineVisuals();
        this.flashTimelineDiamond(frame);
    }

    flashTimelineDiamond(frame) {
        this.updateTimelineVisuals();
        const diamonds = document.querySelectorAll('.keyframe-diamond');
        diamonds.forEach(d => {
            if (parseInt(d.dataset.frame) === frame) {
                d.classList.add('flash-diamond');
                setTimeout(() => d.classList.remove('flash-diamond'), 500);
            }
        });
    }

    updateTimelineVisuals() {
        const track = document.getElementById('timeline-keyframe-track');
        track.innerHTML = '';
        if (!this.activeObject) return;

        const tracks = this.activeObject.userData.animationTracks;
        if (!tracks) return;

        const framesSet = new Set();
        Object.keys(tracks).forEach(trackName => {
            if (tracks[trackName]) {
                Object.keys(tracks[trackName]).forEach(f => framesSet.add(parseInt(f)));
            }
        });

        const totalFrames = this.endFrame - this.startFrame || 1;
        framesSet.forEach(frame => {
            const pct = ((frame - this.startFrame) / totalFrames) * 100;
            if (pct >= 0 && pct <= 100) {
                const diamond = document.createElement('div');
                diamond.className = 'keyframe-diamond';
                diamond.dataset.frame = frame;
                diamond.style.left = `${pct}%`;
                track.appendChild(diamond);
            }
        });
    }

    // --- INTERPOLATION ENGINE (LINEAR / CONSTANT / BEZIER) ---
    applyInterpolatedKeyframes(obj) {
        const tracks = obj.userData.animationTracks;
        if (!tracks) return;

        const interType = document.getElementById('anim-interpolation').value || 'linear';

        // Translate location vector tracks
        if (tracks.location) {
            const val = this.interpolateTrack(tracks.location, this.currentFrame, interType);
            if (val) obj.position.fromArray(val);
        }
        // Translate rotation vector tracks
        if (tracks.rotation) {
            const val = this.interpolateTrack(tracks.rotation, this.currentFrame, interType);
            if (val) obj.rotation.set(val[0], val[1], val[2]);
        }
        // Translate scale vector tracks
        if (tracks.scale) {
            const val = this.interpolateTrack(tracks.scale, this.currentFrame, interType);
            if (val) obj.scale.fromArray(val);
        }
        // Translate custom camera lenses
        if (obj.userData.isCamera && tracks.camera) {
            const camVal = this.interpolateTrack(tracks.camera, this.currentFrame, interType);
            if (camVal && obj.userData.camera) {
                obj.userData.camera.fov = camVal;
                obj.userData.camera.updateProjectionMatrix();
            }
        }
        // Translate custom material outputs
        if (obj.material && tracks.material) {
            const matVal = this.interpolateTrack(tracks.material, this.currentFrame, interType);
            if (matVal) {
                if (obj.material.color && matVal.color) obj.material.color.setHex(matVal.color);
                if (matVal.roughness !== undefined) obj.material.roughness = matVal.roughness;
                if (matVal.opacity !== undefined) {
                    obj.material.opacity = matVal.opacity;
                    obj.material.transparent = matVal.opacity < 1.0;
                }
            }
        }
    }

    interpolateTrack(track, frame, interpolationType) {
        const frames = Object.keys(track).map(Number).sort((a, b) => a - b);
        if (frames.length === 0) return null;

        if (track[frame] !== undefined) return track[frame];
        if (frame <= frames[0]) return track[frames[0]];
        if (frame >= frames[frames.length - 1]) return track[frames[frames.length - 1]];

        let prevFrame = frames[0];
        let nextFrame = frames[0];
        for (let i = 0; i < frames.length; i++) {
            if (frames[i] <= frame) prevFrame = frames[i];
            if (frames[i] >= frame) { nextFrame = frames[i]; break; }
        }

        const t = (frame - prevFrame) / (nextFrame - prevFrame);

        if (interpolationType === 'constant') {
            return track[prevFrame];
        }

        const prevVal = track[prevFrame];
        const nextVal = track[nextFrame];

        // Linear default vector interpolate
        if (Array.isArray(prevVal)) {
            const interpolated = [];
            for (let i = 0; i < prevVal.length; i++) {
                let factor = t;
                if (interpolationType === 'bezier') {
                    factor = t * t * (3.0 - 2.0 * t); // Smoothstep curve approximation
                }
                interpolated.push(prevVal[i] + (nextVal[i] - prevVal[i]) * factor);
            }
            return interpolated;
        }

        // Float track interpolation
        if (typeof prevVal === 'object') {
            // Material structure tracking
            const interpolatedObj = {};
            Object.keys(prevVal).forEach(key => {
                let factor = t;
                if (interpolationType === 'bezier') factor = t * t * (3.0 - 2.0 * t);
                interpolatedObj[key] = prevVal[key] + (nextVal[key] - prevVal[key]) * factor;
            });
            return interpolatedObj;
        }

        // Standard float interpolation
        let factor = t;
        if (interpolationType === 'bezier') factor = t * t * (3.0 - 2.0 * t);
        return prevVal + (nextVal - prevVal) * factor;
    }

    // --- 🖼️ REFERENCE IMAGE IMPORT SYSTEM (NATIVE CORS-SAFE RESOLUTION LOAD) ---
    loadReferenceImage(file) {
        if (!file) return;
        this.showNotification(`Loading Reference: ${file.name}`);
        const url = URL.createObjectURL(file);
        
        // Custom Image implementation loaded natively into a Canvas object to bypass CORS security blocks
        const img = new Image();
        img.onload = () => {
            const texture = new THREE.Texture(img);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.generateMipmaps = true;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.needsUpdate = true;

            const aspect = img.width / img.height;
            const height = 4;
            const width = height * aspect;
            const geometry = new THREE.PlaneGeometry(width, height);

            const material = new THREE.ShaderMaterial({
                uniforms: {
                    map: { value: texture },
                    opacity: { value: 1.0 },
                    brightness: { value: 0.0 },
                    contrast: { value: 1.0 }
                },
                vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    uniform sampler2D map;
                    uniform float opacity;
                    uniform float brightness;
                    uniform float contrast;
                    varying vec2 vUv;
                    void main() {
                        vec4 texColor = texture2D(map, vUv);
                        vec3 color = (texColor.rgb - 0.5) * contrast + 0.5;
                        color += brightness;
                        gl_FragColor = vec4(color, texColor.a * opacity);
                    }
                `,
                transparent: true,
                depthWrite: false, 
                side: THREE.DoubleSide
            });

            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = file.name.split('.')[0];
            mesh.userData.isReferenceImage = true;
            mesh.userData.opacity = 1.0;
            mesh.userData.brightness = 0.0;
            mesh.userData.contrast = 1.0;
            mesh.userData.isLocked = false;
            mesh.userData.doubleSided = true;

            // Project reference plane in front of viewport camera
            const cameraDir = new THREE.Vector3();
            const activeCam = this.isViewingThroughCamera && this.activeCamera ? this.activeCamera : this.camera;
            activeCam.getWorldDirection(cameraDir);
            mesh.position.copy(activeCam.position).addScaledVector(cameraDir, 5);
            mesh.lookAt(activeCam.position);

            this.scene.add(mesh);
            this.objects.push(mesh);
            this.selectObject(mesh);
            this.updateOutliner();

            this.pushHistory({
                type: 'create',
                uuid: mesh.uuid,
                before: null,
                after: mesh
            });

            this.showNotification("Reference Image Loaded");
        };
        img.onerror = (err) => {
            console.error("Error parsing texture element:", err);
            this.showNotification("Failed to load reference image.");
        };
        img.src = url;
    }

    recreateReferenceImage(data) {
        const img = new Image();
        img.src = data.imageDataUrl;
        const texture = new THREE.Texture(img);
        img.onload = () => { texture.needsUpdate = true; };

        texture.colorSpace = THREE.SRGBColorSpace;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;

        const geometry = new THREE.PlaneGeometry(1, 1); 
        const material = new THREE.ShaderMaterial({
            uniforms: {
                map: { value: texture },
                opacity: { value: data.opacity },
                brightness: { value: data.brightness },
                contrast: { value: data.contrast }
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D map;
                uniform float opacity;
                uniform float brightness;
                uniform float contrast;
                varying vec2 vUv;
                void main() {
                    vec4 texColor = texture2D(map, vUv);
                    vec3 color = (texColor.rgb - 0.5) * contrast + 0.5;
                    color += brightness;
                    gl_FragColor = vec4(color, texColor.a * opacity);
                }
            `,
            transparent: true,
            depthWrite: false,
            side: data.doubleSided ? THREE.DoubleSide : THREE.FrontSide
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = data.name;
        mesh.userData.isReferenceImage = true;
        mesh.userData.opacity = data.opacity;
        mesh.userData.brightness = data.brightness;
        mesh.userData.contrast = data.contrast;
        mesh.userData.isLocked = data.isLocked || false;
        mesh.userData.doubleSided = data.doubleSided !== undefined ? data.doubleSided : true;

        return mesh;
    }

    alignReference(axis) {
        if (!this.activeObject || !this.activeObject.userData.isReferenceImage) return;
        const obj = this.activeObject;
        const beforeState = { position: obj.position.clone(), rotation: obj.rotation.clone(), scale: obj.scale.clone() };

        obj.rotation.set(0, 0, 0);
        if (axis === 'front') obj.rotation.set(0, 0, 0);
        else if (axis === 'side') obj.rotation.set(0, Math.PI / 2, 0);
        else if (axis === 'top') obj.rotation.set(-Math.PI / 2, 0, 0);
        else if (axis === 'back') obj.rotation.set(0, Math.PI, 0);

        this.pushHistory({
            type: 'transform',
            uuid: obj.uuid,
            before: beforeState,
            after: { position: obj.position.clone(), rotation: obj.rotation.clone(), scale: obj.scale.clone() }
        });
        this.updateTransformUI();
    }

    createExtendedMaterial() {
        const mat = new THREE.MeshPhysicalMaterial({
            color: 0xa38c7a, roughness: 0.6, metalness: 0.1,
            emissive: 0x000000, emissiveIntensity: 0.0,
            transparent: true, opacity: 1.0, transmission: 0.0, ior: 1.5,
            clearcoat: 0.0, 
            side: THREE.DoubleSide
        });
        mat.userData.iou = 0.0;
        return mat;
    }

    // --- 🎥 CAMERA OBJECT GENERATOR ---
    createCamera(uuid = null, name = null, fov = 50, near = 0.1, far = 1000) {
        const camGroup = new THREE.Group();
        camGroup.name = name || `Camera_${this.objects.length}`;
        if (uuid) camGroup.uuid = uuid;
        camGroup.userData.isCamera = true;

        const container = document.getElementById('viewport');
        const aspect = container ? container.clientWidth / container.clientHeight : 1.6;
        const cam = new THREE.PerspectiveCamera(fov, aspect, near, far);
        
        camGroup.add(cam);
        camGroup.userData.camera = cam;

        // Physical camera representation (Pyramidal lens and body)
        const bodyGeom = new THREE.BoxGeometry(0.6, 0.4, 0.5);
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4d4d4d, roughness: 0.6 });
        const body = new THREE.Mesh(bodyGeom, bodyMat);
        body.userData.isCameraHelperMesh = true;
        camGroup.add(body);
        
        const lensGeom = new THREE.CylinderGeometry(0.15, 0.25, 0.4, 8);
        lensGeom.rotateX(Math.PI/2);
        lensGeom.translate(0, 0, -0.45);
        const lens = new THREE.Mesh(lensGeom, bodyMat);
        lens.userData.isCameraHelperMesh = true;
        camGroup.add(lens);

        return camGroup;
    }

    // --- 🔌 addCameraObject restored completely to resolve startup crash ---
    addCameraObject(name = null) {
        const camGroup = this.createCamera(null, name);
        if(this.activeObject && this.activeObject.userData.isFolder) {
            this.activeObject.add(camGroup);
        } else {
            this.scene.add(camGroup);
        }
        this.objects.push(camGroup);

        // Auto-assign first scene camera as default Active render target
        if (!this.activeSceneCamera) {
            this.activeSceneCamera = camGroup;
        }

        this.pushHistory({
            type: 'create',
            uuid: camGroup.uuid,
            before: null,
            after: camGroup
        });

        this.selectObject(camGroup);
        this.updateOutliner();
    }

    // --- 🔌 updateCameraView restored completely to allow seamless switching ---
    updateCameraView() {
        const btnTop = document.getElementById('btn-camera-view');
        const btnSide = document.getElementById('sidebar-btn-cam-view');

        if (this.isViewingThroughCamera) {
            let targetCamObj = null;
            if (this.activeObject && this.activeObject.userData.isCamera) {
                targetCamObj = this.activeObject;
            } else {
                targetCamObj = this.activeSceneCamera || this.objects.find(o => o.userData.isCamera);
            }

            if (!targetCamObj) {
                this.showNotification("No camera object exists. Falling back to free view.");
                this.isViewingThroughCamera = false;
                return;
            }

            this.activeCamera = targetCamObj.userData.camera;
            this.orbit.enabled = false;

            // Make camera indicator mesh invisible so it does not block the perspective view
            targetCamObj.children.forEach(c => {
                if (c.userData.isCameraHelperMesh) c.visible = false;
            });

            btnTop.textContent = "Exit Camera View";
            btnTop.style.background = "var(--accent)";
            btnSide.textContent = "Exit Camera View";
            btnSide.style.background = "var(--accent)";
        } else {
            this.orbit.enabled = true;
            this.activeCamera = null;

            // Restore visibility of helper meshes
            this.scene.traverse(child => {
                if (child.userData.isCameraHelperMesh) child.visible = true;
            });

            btnTop.textContent = "View Through Camera";
            btnTop.style.background = "var(--bg-input)";
            btnSide.textContent = "View Through Camera";
            btnSide.style.background = "var(--bg-input)";
        }
    }

    // --- HISTORY (UNDO/REDO) SYSTEM ---
    pushHistory(action) {
        this.undoStack.push(action);
        if (this.undoStack.length > this.maxHistory) {
            this.undoStack.shift();
        }
        this.redoStack = []; 
    }

    undo() {
        if (this.undoStack.length === 0) return;
        const action = this.undoStack.pop();
        this.redoStack.push(action);
        this.applyHistoryState(action, 'before');
    }

    redo() {
        if (this.redoStack.length === 0) return;
        const action = this.redoStack.pop();
        this.undoStack.push(action);
        this.applyHistoryState(action, 'after');
    }

    applyHistoryState(action, stateKey) {
        const state = action[stateKey];
        const target = this.scene.getObjectByProperty('uuid', action.uuid);

        if (!target && action.type !== 'create' && action.type !== 'delete') return;

        if (action.type === 'transform') {
            target.position.copy(state.position);
            target.rotation.copy(state.rotation);
            target.scale.copy(state.scale);
            this.updateTransformUI();
        } else if (action.type === 'sculpt') {
            const posAttr = target.geometry.attributes.position;
            posAttr.copyArray(state);
            posAttr.needsUpdate = true;
            target.geometry.computeVertexNormals();
        } else if (action.type === 'create') {
            if (stateKey === 'before') {
                this.silentDelete(target);
            } else {
                this.scene.add(target);
                if ((target.isMesh || target.userData.isCamera || target.userData.isReferenceImage) && !this.objects.includes(target)) this.objects.push(target);
            }
        } else if (action.type === 'delete') {
            if (stateKey === 'before') {
                this.scene.add(target);
                if ((target.isMesh || target.userData.isCamera || target.userData.isReferenceImage) && !this.objects.includes(target)) this.objects.push(target);
            } else {
                this.silentDelete(target);
            }
        }
        this.updateOutliner();
    }

    silentDelete(obj) {
        if (!obj) return;
        if (obj === this.activeObject) this.selectObject(null);
        if (obj.parent) obj.parent.remove(obj);
        if (obj.isMesh || obj.userData.isCamera || obj.userData.isReferenceImage) {
            this.objects = this.objects.filter(o => o !== obj);
        }
    }

    // --- PROJECT SAVE & LOAD ---
    saveProject() {
        const projectData = {
            version: "1.2",
            hierarchy: this.serializeNode(this.scene)
        };

        const jsonString = JSON.stringify(projectData);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const link = document.createElement('a');
        link.style.display = 'none';
        link.href = URL.createObjectURL(blob);
        link.download = `project_${new Date().getTime()}.webblend`;
        
        // Append anchor strictly to document body to trigger download context safely
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    loadProject(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const projectData = JSON.parse(e.target.result);
                this.clearScene();
                this.deserializeNode(projectData.hierarchy, this.scene);
                this.updateOutliner();
                this.selectObject(null);
            } catch (err) {
                console.error(err);
                alert("Failed to parse project file.");
            }
        };
        reader.readAsText(file);
    }

    clearScene() {
        const toDelete = this.scene.children.filter(c => !c.userData.isHelper && !c.isLight && !c.isCamera);
        toDelete.forEach(c => this.scene.remove(c));
        this.objects = [];
        this.activeObject = null;
        this.undoStack = [];
        this.redoStack = [];
        this.isViewingThroughCamera = false;
        this.activeCamera = null;
        this.activeSceneCamera = null;
    }

    serializeNode(node) {
        const childrenData = [];
        node.children.forEach(child => {
            if (child.userData.isHelper || child.isLight || child.isCamera) return;
            
            const childData = {
                uuid: child.uuid,
                name: child.name,
                position: child.position.toArray(),
                rotation: [child.rotation.x, child.rotation.y, child.rotation.z],
                scale: child.scale.toArray(),
                userData: child.userData
            };

            if (child.isMesh) {
                if (child.userData.isReferenceImage) {
                    childData.type = "referenceImage";
                    childData.opacity = child.userData.opacity;
                    childData.brightness = child.userData.brightness;
                    childData.contrast = child.userData.contrast;
                    childData.isLocked = child.userData.isLocked;
                    childData.doubleSided = child.userData.doubleSided;
                    
                    // Offline conversion to store reference images securely inside the .webblend file layout
                    const canvas = document.createElement('canvas');
                    const img = child.material.uniforms.map.value.image;
                    if (img) {
                        canvas.width = img.width || 128;
                        canvas.height = img.height || 128;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0);
                        childData.imageDataUrl = canvas.toDataURL('image/png');
                    }
                } else {
                    childData.type = "mesh";
                    childData.primitive = child.userData.primitiveType || "cube";
                    childData.material = {
                        color: child.material.color.getHex(),
                        roughness: child.material.roughness,
                        metalness: child.material.metalness,
                        emissive: child.material.emissive.getHex(),
                        opacity: child.material.opacity,
                        transmission: child.material.transmission,
                        ior: child.material.ior,
                        iou: child.material.userData.iou
                    };
                    childData.vertices = Array.from(child.geometry.attributes.position.array);
                }
            } else if (child.userData.isCamera) {
                childData.type = "camera";
                childData.fov = child.userData.camera.fov;
                childData.near = child.userData.camera.near;
                childData.far = child.userData.camera.far;
                childData.isActive = (this.activeSceneCamera === child);
            } else if (child.userData.isFolder) {
                childData.type = "folder";
                childData.children = this.serializeNode(child);
            }
            childrenData.push(childData);
        });
        return childrenData;
    }

    deserializeNode(nodeDataList, parentNode) {
        nodeDataList.forEach(data => {
            let obj;
            if (data.type === "mesh") {
                let geometry;
                const segments = 64;
                if (data.primitive === 'sphere') geometry = new THREE.SphereGeometry(1.5, segments, segments);
                else if (data.primitive === 'cylinder') geometry = new THREE.CylinderGeometry(1, 1, 2, segments, 1);
                else if (data.primitive === 'plane') { geometry = new THREE.PlaneGeometry(4, 4, segments, segments); geometry.rotateX(-Math.PI/2); }
                else geometry = new THREE.BoxGeometry(2, 2, 2, segments, segments, segments);

                if (data.vertices) {
                    const posAttr = geometry.attributes.position;
                    posAttr.copyArray(new Float32Array(data.vertices));
                    posAttr.needsUpdate = true;
                    geometry.computeVertexNormals();
                }

                const material = this.createExtendedMaterial();
                material.color.setHex(data.material.color);
                material.roughness = data.material.roughness;
                material.metalness = data.material.metalness;
                material.emissive.setHex(data.material.emissive);
                material.opacity = data.material.opacity;
                material.transparent = data.material.opacity < 1.0;
                material.transmission = data.material.transmission;
                material.ior = data.material.ior;
                material.userData.iou = data.material.iou;
                material.clearcoat = data.material.iou;

                obj = new THREE.Mesh(geometry, material);
                obj.castShadow = true; obj.receiveShadow = true;
                obj.userData.primitiveType = data.primitive;
                this.objects.push(obj);
            } else if (data.type === "referenceImage") {
                obj = this.recreateReferenceImage(data);
                this.objects.push(obj);
            } else if (data.type === "camera") {
                obj = this.createCamera(data.uuid, data.name, data.fov, data.near, data.far);
                this.objects.push(obj);
                if (data.isActive) {
                    this.activeSceneCamera = obj;
                }
            } else if (data.type === "folder") {
                obj = new THREE.Group();
                obj.userData.isFolder = true;
                obj.userData.expanded = data.userData.expanded;
                this.deserializeNode(data.children, obj);
            }

            if (obj) {
                obj.uuid = data.uuid;
                obj.name = data.name;
                obj.position.fromArray(data.position);
                obj.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2]);
                obj.scale.fromArray(data.scale);
                parentNode.add(obj);
            }
        });

        // Ensure at least one camera is set active if loaded cameras had no active flag
        if (!this.activeSceneCamera) {
            const firstCam = this.objects.find(o => o.userData.isCamera);
            if (firstCam) this.activeSceneCamera = firstCam;
        }
    }

    // --- OUTLINER & FOLDER SYSTEM ---
    createFolder(name = "New Collection") {
        const folder = new THREE.Group();
        folder.name = name;
        folder.userData.isFolder = true;
        folder.userData.expanded = true;
        
        if(this.activeObject && this.activeObject.userData.isFolder) {
            this.activeObject.add(folder);
        } else {
            this.scene.add(folder);
        }

        this.pushHistory({
            type: 'create',
            uuid: folder.uuid,
            before: null,
            after: folder
        });

        this.updateOutliner();
    }

    deleteObject(obj) {
        if(!obj) return;
        this.silentDelete(obj);

        if (obj.userData.isCamera && this.isViewingThroughCamera && this.activeCamera === obj.userData.camera) {
            this.isViewingThroughCamera = false;
            this.updateCameraView();
        }

        if (this.activeSceneCamera === obj) {
            this.activeSceneCamera = this.objects.find(o => o.userData.isCamera && o !== obj) || null;
        }

        this.pushHistory({
            type: 'delete',
            uuid: obj.uuid,
            before: obj,
            after: null
        });

        this.updateOutliner();
    }

    getSelectableParent(obj) {
        while (obj) {
            if (this.objects.includes(obj)) return obj;
            obj = obj.parent;
        }
        return null;
    }

    updateOutliner() {
        const container = document.getElementById('outliner');
        container.innerHTML = '';
        this.renderOutlinerNode(this.scene, container, 0);
    }

    renderOutlinerNode(node, container, depth) {
        node.children.forEach(child => {
            if (child.userData.isHelper || child.isLight || child.isCamera) return;

            const li = document.createElement('li');
            li.className = `outliner-item ${child.userData.isFolder ? 'folder' : ''}`;
            li.dataset.uuid = child.uuid;
            if (this.activeObject === child) li.classList.add('selected');
            
            li.draggable = true;
            li.ondragstart = (e) => { e.dataTransfer.setData('text/plain', child.uuid); e.stopPropagation(); };
            li.ondragover = (e) => { e.preventDefault(); li.classList.add('drag-over'); e.stopPropagation(); };
            li.ondragleave = (e) => { li.classList.remove('drag-over'); };
            li.ondrop = (e) => {
                e.preventDefault(); e.stopPropagation();
                li.classList.remove('drag-over');
                const draggedId = e.dataTransfer.getData('text/plain');
                const draggedObj = this.scene.getObjectByProperty('uuid', draggedId);
                
                if (draggedObj && draggedObj !== child) {
                    if (child.userData.isFolder) child.attach(draggedObj); 
                    else if (child.parent) child.parent.attach(draggedObj);

                    this.pushHistory({
                        type: 'transform',
                        uuid: draggedObj.uuid,
                        before: { position: draggedObj.position.clone(), rotation: draggedObj.rotation.clone(), scale: draggedObj.scale.clone() },
                        after: { position: draggedObj.position.clone(), rotation: draggedObj.rotation.clone(), scale: draggedObj.scale.clone() }
                    });

                    this.updateOutliner();
                }
            };

            const expander = document.createElement('span');
            expander.className = 'expander';
            if (child.userData.isFolder && child.children.length > 0) {
                expander.innerText = child.userData.expanded ? '▼' : '▶';
                expander.onclick = (e) => { e.stopPropagation(); child.userData.expanded = !child.userData.expanded; this.updateOutliner(); };
            }
            li.appendChild(expander);

            const icon = document.createElement('span');
            icon.className = 'icon';
            if (child.userData.isFolder) icon.innerText = '📁';
            else if (child.userData.isCamera) icon.innerText = '📷';
            else if (child.userData.isReferenceImage) icon.innerText = '🖼️';
            else icon.innerText = '📦';
            li.appendChild(icon);

            const name = document.createElement('span');
            name.className = 'name';
            
            // Render active camera indicators inside outliner node
            if (child.userData.isCamera && this.activeSceneCamera === child) {
                name.innerText = `${child.name} (🎥 ACTIVE)`;
            } else {
                name.innerText = child.name || "Object";
            }
            li.appendChild(name);

            const delBtn = document.createElement('span');
            delBtn.className = 'delete-btn';
            delBtn.innerText = '✖';
            delBtn.onclick = (e) => { e.stopPropagation(); this.deleteObject(child); };
            li.appendChild(delBtn);

            li.onclick = (e) => { e.stopPropagation(); this.selectObject(child); };
            container.appendChild(li);

            if (child.userData.isFolder && child.userData.expanded) {
                const subContainer = document.createElement('ul');
                subContainer.className = 'outliner-children';
                container.appendChild(subContainer);
                this.renderOutlinerNode(child, subContainer, depth + 1);
            }
        });
    }

    // --- IMPORT & ADDING ---
    handleImport(file) {
        if (!file) return;
        const ext = file.name.split('.').pop().toLowerCase();
        const url = URL.createObjectURL(file);
        
        document.getElementById('loading').style.display = 'block';
        document.getElementById('loading').textContent = 'Loading ' + file.name + '...';

        const onError = (err) => {
            console.error('[WebBlend] Import error:', err);
            document.getElementById('loading').style.display = 'none';
            this.showNotification('Import failed: ' + (err.message || err));
        };

        const onLoad = (object) => {
            try {
                let model = object.scene || object;
                const folder = new THREE.Group();
                folder.name = file.name.split('.')[0] + " (Import)";
                folder.userData.isFolder = true;
                folder.userData.expanded = true;

                let meshCount = 0;
                model.traverse((child) => {
                    if (child.isMesh) {
                        meshCount++;
                        const hasTexture = child.material &&
                            (child.material.map ||
                             child.material.normalMap ||
                             child.material.roughnessMap ||
                             child.material.metalnessMap ||
                             child.material.aoMap ||
                             child.material.emissiveMap ||
                             child.material.alphaMap);
                        if (hasTexture) {
                            child.material.side = THREE.DoubleSide;
                            child.material.transparent = child.material.opacity < 1;
                            child.material.needsUpdate = true;
                        } else if (child.material) {
                            const oldColor = child.material.color ? child.material.color.clone() : new THREE.Color(0xa38c7a);
                            const oldRoughness = child.material.roughness != null ? child.material.roughness : 0.6;
                            const oldMetalness = child.material.metalness != null ? child.material.metalness : 0.1;
                            child.material = this.createExtendedMaterial();
                            child.material.color.copy(oldColor);
                            child.material.roughness = oldRoughness;
                            child.material.metalness = oldMetalness;
                        }
                        child.castShadow = true; child.receiveShadow = true;
                        child.geometry.computeVertexNormals();
                        this.objects.push(child);
                    }
                });

                if (meshCount === 0) throw new Error('No meshes found in file');

                const box = new THREE.Box3().setFromObject(model);
                const size = box.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z);
                if (maxDim > 0) {
                    const scale = 4.0 / maxDim;
                    model.scale.set(scale, scale, scale);
                    model.position.sub(box.getCenter(new THREE.Vector3()).multiplyScalar(scale));
                }
                
                folder.add(model);
                this.scene.add(folder);
                
                this.pushHistory({
                    type: 'create',
                    uuid: folder.uuid,
                    before: null,
                    after: folder
                });

                this.selectObject(folder);
                this.updateOutliner();
                document.getElementById('loading').style.display = 'none';
                this.showNotification('Imported: ' + file.name);
            } catch (e) {
                onError(e);
            }
        };

        try {
            if (ext === 'glb' || ext === 'gltf') new GLTFLoader().load(url, onLoad, undefined, onError);
            else if (ext === 'fbx') new FBXLoader().load(url, onLoad, undefined, onError);
            else if (ext === 'obj') new OBJLoader().load(url, onLoad, undefined, onError);
            else {
                document.getElementById('loading').style.display = 'none';
                this.showNotification('Unsupported format: .' + ext);
            }
        } catch (e) {
            onError(e);
        }
    }

    addPrimitive(type) {
        let geometry;
        const segments = 64;
        if(type === 'cube') geometry = new THREE.BoxGeometry(2, 2, 2, segments, segments, segments);
        else if(type === 'sphere') geometry = new THREE.SphereGeometry(1.5, segments, segments);
        else if(type === 'cylinder') geometry = new THREE.CylinderGeometry(1, 1, 2, segments, 1);
        else if(type === 'plane') { geometry = new THREE.PlaneGeometry(4, 4, segments, segments); geometry.rotateX(-Math.PI/2); }

        const mesh = new THREE.Mesh(geometry, this.createExtendedMaterial());
        mesh.name = `${type.charAt(0).toUpperCase() + type.slice(1)}_${this.objects.length}`;
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.userData.primitiveType = type;
        
        if(this.activeObject && this.activeObject.userData.isFolder) {
            this.activeObject.add(mesh);
        } else {
            this.scene.add(mesh);
        }
        
        this.objects.push(mesh);

        this.pushHistory({
            type: 'create',
            uuid: mesh.uuid,
            before: null,
            after: mesh
        });

        this.selectObject(mesh);
        this.updateOutliner();
    }

    // --- SHORTCUTS & CORE LOGIC ---
    setupShortcuts() {
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            const key = e.key.toLowerCase();

            if (key === 'g' && this.activeObject) {
                // If reference layer is locked, prevent translations
                if (this.activeObject.userData.isReferenceImage && this.activeObject.userData.isLocked) return;
                this.transformControl.setMode('translate');
            }
            if (key === 'r' && this.activeObject) {
                if (this.activeObject.userData.isReferenceImage && this.activeObject.userData.isLocked) return;
                this.transformControl.setMode('rotate');
            }
            if (key === 's' && this.activeObject) {
                if (this.activeObject.userData.isReferenceImage && this.activeObject.userData.isLocked) return;
                this.transformControl.setMode('scale');
            }
            
            if ((key === 'delete' || key === 'backspace') && this.activeObject) {
                this.deleteObject(this.activeObject);
            }

            if (key === 'i' && this.activeObject) {
                // ⌨ Manual Keyframe insertion trigger
                this.recordTransformKeyframe(this.activeObject);
                if (this.activeObject.material) {
                    this.recordMaterialKeyframe(this.activeObject);
                }
                this.showNotification(`Keyframe inserted on Frame ${this.currentFrame}`);
            }

            if (e.ctrlKey && (e.key === '0' || e.code === 'Numpad0')) {
                e.preventDefault();
                this.isViewingThroughCamera = !this.isViewingThroughCamera;
                this.updateCameraView();
            }

            if (key === 'z' && e.ctrlKey) {
                e.preventDefault();
                this.undo();
            }
            if (key === 'y' && e.ctrlKey) {
                e.preventDefault();
                this.redo();
            }

            if (key === 'a' && !e.ctrlKey) {
                if (this.activeObject) this.selectObject(null);
                else if (this.objects.length > 0) this.selectObject(this.objects[0]); 
            }
            if (key === 'a' && e.ctrlKey) {
                e.preventDefault();
                if (this.objects.length > 0) this.selectObject(this.objects[0]);
            }

            if (key === 'c' && e.ctrlKey && this.activeObject) {
                this.clipboard = this.activeObject;
            }

            if (key === 'v' && e.ctrlKey && this.clipboard) {
                const clone = this.clipboard.clone();
                clone.position.x += 0.5; clone.position.z += 0.5;
                clone.name = this.clipboard.name + " (Copy)";
                
                if (this.clipboard.parent) this.clipboard.parent.add(clone);
                else this.scene.add(clone);
                
                if (clone.isMesh) this.objects.push(clone);
                else if (clone.userData.isCamera) this.objects.push(clone);
                else clone.traverse(child => { if(child.isMesh || child.userData.isCamera) this.objects.push(child); });
                
                this.pushHistory({
                    type: 'create',
                    uuid: clone.uuid,
                    before: null,
                    after: clone
                });

                this.selectObject(clone);
                this.updateOutliner();
            }
        });
    }

    onPointerDown(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        if (this.currentMode === 'sculpt' && this.activeObject && this.activeObject.isMesh && !this.activeObject.userData.isReferenceImage) {
            this.isSculpting = true; 
            this.orbit.enabled = false; 
            this.sculptStartPositions = this.activeObject.geometry.attributes.position.array.slice();
            this.sculptStep(); 
            return;
        }

        if (this.transformControl.dragging) return;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        
        // Filter raycast against our tracking list of scene entities
        const intersects = this.raycaster.intersectObjects(this.objects, true);

        if (intersects.length > 0) {
            const selectableParent = this.getSelectableParent(intersects[0].object);
            if (selectableParent) {
                // If the targeted reference plane is locked, ignore raycast hits on it and select background layers instead
                if (selectableParent.userData.isReferenceImage && selectableParent.userData.isLocked) {
                    const unlockedIntersects = intersects.filter(i => {
                        const parentNode = this.getSelectableParent(i.object);
                        return !(parentNode && parentNode.userData.isReferenceImage && parentNode.userData.isLocked);
                    });
                    if (unlockedIntersects.length > 0) {
                        const behindParent = this.getSelectableParent(unlockedIntersects[0].object);
                        this.selectObject(behindParent);
                    } else if (this.currentMode === 'object' || this.currentMode === 'edit') {
                        this.selectObject(null);
                    }
                } else {
                    this.selectObject(selectableParent);
                }
            } else if (this.currentMode === 'object' || this.currentMode === 'edit') {
                this.selectObject(null);
            }
        } else if (this.currentMode === 'object' || this.currentMode === 'edit') {
            this.selectObject(null);
        }
    }

    onPointerMove(event) {
        if (!this.isSculpting) return;
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        this.sculptStep();
    }

    onPointerUp() {
        if (this.isSculpting) {
            this.isSculpting = false; this.orbit.enabled = true;
            if(this.activeObject && this.activeObject.isMesh) {
                this.activeObject.geometry.computeVertexNormals();
                if (this.sculptStartPositions) {
                    const endPositions = this.activeObject.geometry.attributes.position.array.slice();
                    this.pushHistory({
                        type: 'sculpt',
                        uuid: this.activeObject.uuid,
                        before: this.sculptStartPositions,
                        after: endPositions
                    });
                    this.sculptStartPositions = null;
                }
            }
        }
    }

    sculptStep() {
        if(!this.activeObject || !this.activeObject.isMesh || this.activeObject.userData.isReferenceImage) return;
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObject(this.activeObject);
        if (intersects.length > 0) {
            const point = intersects[0].point;
            const geom = this.activeObject.geometry;
            const positions = geom.attributes.position;
            const invMat = this.activeObject.matrixWorld.clone().invert();
            const localPoint = point.clone().applyMatrix4(invMat);
            const radiusSq = this.brushRadius * this.brushRadius;
            
            for (let i = 0; i < positions.count; i++) {
                const v = new THREE.Vector3().fromBufferAttribute(positions, i);
                const dSq = v.distanceToSquared(localPoint);
                if (dSq < radiusSq) {
                    const falloff = Math.pow(1.0 - (dSq / radiusSq), 2);
                    const n = new THREE.Vector3().fromBufferAttribute(geom.attributes.normal, i);
                    
                    let disp = 0;
                    if (this.brushType === 'sculpt-draw') disp = this.brushStrength * falloff * 0.1;
                    else if (this.brushType === 'sculpt-flatten') disp = -this.brushStrength * falloff * 0.1; 
                    
                    v.addScaledVector(n, disp);
                    if (this.brushType === 'sculpt-smooth') v.lerp(localPoint, this.brushStrength * falloff * 0.05);
                    positions.setXYZ(i, v.x, v.y, v.z);
                }
            }
            positions.needsUpdate = true;
        }
    }

    selectObject(obj) {
        this.activeObject = obj;
        if (obj && (this.currentMode === 'object' || this.currentMode === 'edit' || this.currentMode === 'animation')) {
            // Detach gizmo controls if the selected reference image layer is locked
            if (obj.userData.isReferenceImage && obj.userData.isLocked) {
                this.transformControl.detach();
            } else {
                this.transformControl.attach(obj);
            }
        } else {
            this.transformControl.detach();
        }
        
        this.updateOutliner();
        this.updateTransformUI();
        this.updateMaterialUI();
        this.updateObjectUI();
        this.updateUIMode();
        this.updateTimelineVisuals();
    }

    updateObjectUI() {
        if(!this.activeObject) return;
        document.getElementById('obj-name').value = this.activeObject.name;
        document.getElementById('obj-visible').checked = this.activeObject.visible;
        document.getElementById('obj-shadow').checked = this.activeObject.castShadow;
        
        if (this.activeObject.material && !this.activeObject.userData.isReferenceImage) {
            document.getElementById('obj-wireframe').checked = this.activeObject.material.wireframe || false;
            document.getElementById('obj-smooth').checked = !this.activeObject.material.flatShading;
        }
    }

    updateTransformUI() {
        if(!this.activeObject) return;
        document.getElementById('loc-x').value = this.activeObject.position.x.toFixed(2);
        document.getElementById('loc-y').value = this.activeObject.position.y.toFixed(2);
        document.getElementById('loc-z').value = this.activeObject.position.z.toFixed(2);
    }

    updateMaterialUI() {
        if(!this.activeObject) return;
        if (this.activeObject.userData.isCamera) {
            const cam = this.activeObject.userData.camera;
            document.getElementById('cam-fov').value = cam.fov;
            document.getElementById('cam-near').value = cam.near;
            document.getElementById('cam-far').value = cam.far;
            return;
        }
        if (this.activeObject.userData.isReferenceImage) {
            document.getElementById('ref-opacity').value = this.activeObject.userData.opacity;
            document.getElementById('ref-brightness').value = this.activeObject.userData.brightness;
            document.getElementById('ref-contrast').value = this.activeObject.userData.contrast;
            document.getElementById('ref-double-sided').checked = this.activeObject.userData.doubleSided;
            document.getElementById('ref-lock').checked = this.activeObject.userData.isLocked;
            return;
        }
        if (!this.activeObject.material) return;
        const mat = this.activeObject.material;
        document.getElementById('mat-color').value = '#' + mat.color.getHexString();
        document.getElementById('mat-roughness').value = mat.roughness;
        document.getElementById('mat-metallic').value = mat.metalness || 0;
        document.getElementById('mat-emissive').value = '#' + mat.emissive.getHexString();
        document.getElementById('mat-opacity').value = mat.opacity;
        if(mat.transmission !== undefined) document.getElementById('mat-transmission').value = mat.transmission;
        if(mat.ior !== undefined) document.getElementById('mat-ior').value = mat.ior;
        if(mat.userData.iou !== undefined) document.getElementById('mat-iou').value = mat.userData.iou;
    }

    /* 🔌 Uses .hidden Class toggling to preserve natural displays */
    updateUIMode() {
        const isSculpt = this.currentMode === 'sculpt';
        const isEdit = this.currentMode === 'edit';
        const isObject = this.currentMode === 'object';
        const isAnimation = this.currentMode === 'animation';
        
        const showObjPanel = (isObject || isEdit || isAnimation);
        
        document.querySelectorAll('.sculpt-only, .sculpt-tool').forEach(el => {
            el.classList.toggle('hidden', !isSculpt);
        });
        
        document.querySelectorAll('.obj-tool').forEach(el => {
            el.classList.toggle('hidden', !showObjPanel);
        });

        const isCameraSelected = this.activeObject && this.activeObject.userData.isCamera === true;
        const isReferenceImageSelected = this.activeObject && this.activeObject.userData.isReferenceImage === true;
        
        document.querySelectorAll('.camera-only').forEach(el => {
            el.classList.toggle('hidden', !(showObjPanel && isCameraSelected));
        });

        document.querySelectorAll('.reference-image-only').forEach(el => {
            el.classList.toggle('hidden', !(showObjPanel && isReferenceImageSelected));
        });
        
        document.querySelectorAll('.material-panel').forEach(el => {
            el.classList.toggle('hidden', !(showObjPanel && !isCameraSelected && !isReferenceImageSelected));
        });

        // ⏱️ Auto-show or hide bottom timeline dock dynamically based on animation workspace mode
        document.getElementById('timeline-dock').classList.toggle('hidden', !isAnimation);

        if ((isObject || isEdit || isAnimation) && this.activeObject) {
            if (this.activeObject.userData.isReferenceImage && this.activeObject.userData.isLocked) {
                this.transformControl.detach();
            } else {
                this.transformControl.attach(this.activeObject);
            }
        } else {
            this.transformControl.detach();
        }

        this.objects.forEach(obj => { if(obj.material && !obj.userData.isReferenceImage) obj.material.wireframe = isEdit; });
        this.updateObjectUI();
    }

    setupUI() {
        document.getElementById('mode-select').addEventListener('change', e => { this.currentMode = e.target.value; this.updateUIMode(); });

        const modal = document.getElementById('prefs-modal');
        document.getElementById('menu-prefs').addEventListener('click', () => modal.style.display = 'flex');
        document.getElementById('close-prefs').addEventListener('click', () => modal.style.display = 'none');
        
        const prefCompact = document.getElementById('pref-compact');
        const prefOpacity = document.getElementById('pref-opacity');
        const prefFont = document.getElementById('pref-font');
        const prefRenderSource = document.getElementById('pref-render-source');

        // Viewport preferences configuration bindings
        const prefGridSize = document.getElementById('pref-grid-size');
        const prefGridDivs = document.getElementById('pref-grid-divisions');
        const prefGridMainColor = document.getElementById('pref-grid-main-color');
        const prefGridSubColor = document.getElementById('pref-grid-sub-color');
        const prefGridOpacity = document.getElementById('pref-grid-opacity');
        const prefGridThickness = document.getElementById('pref-grid-thickness');
        const prefInfiniteGrid = document.getElementById('pref-infinite-grid');
        
        prefCompact.checked = this.prefs.compactMode; 
        prefOpacity.value = this.prefs.opacity; 
        prefFont.value = this.prefs.fontSize;
        prefRenderSource.value = this.prefs.renderCameraSource || "active_scene_camera";

        prefGridSize.value = this.prefs.gridSize || 20;
        prefGridDivs.value = this.prefs.gridDivisions || 20;
        prefGridMainColor.value = this.prefs.gridMainColor || "#444444";
        prefGridSubColor.value = this.prefs.gridSubColor || "#222222";
        prefGridOpacity.value = this.prefs.gridOpacity !== undefined ? this.prefs.gridOpacity : 0.5;
        prefGridThickness.value = this.prefs.gridThickness || "normal";
        prefInfiniteGrid.checked = this.prefs.infiniteGrid !== undefined ? this.prefs.infiniteGrid : true;

        prefCompact.addEventListener('change', e => { this.prefs.compactMode = e.target.checked; this.savePreferences(); });
        prefOpacity.addEventListener('input', e => { this.prefs.opacity = parseFloat(e.target.value); this.savePreferences(); });
        prefFont.addEventListener('input', e => { this.prefs.fontSize = parseInt(e.target.value); this.savePreferences(); });
        prefRenderSource.addEventListener('change', e => { this.prefs.renderCameraSource = e.target.value; this.savePreferences(); });

        prefGridSize.addEventListener('change', e => { this.prefs.gridSize = parseInt(e.target.value); this.savePreferences(); });
        prefGridDivs.addEventListener('change', e => { this.prefs.gridDivisions = parseInt(e.target.value); this.savePreferences(); });
        prefGridMainColor.addEventListener('input', e => { this.prefs.gridMainColor = e.target.value; this.savePreferences(); });
        prefGridSubColor.addEventListener('input', e => { this.prefs.gridSubColor = e.target.value; this.savePreferences(); });
        prefGridOpacity.addEventListener('input', e => { this.prefs.gridOpacity = parseFloat(e.target.value); this.savePreferences(); });
        prefGridThickness.addEventListener('change', e => { this.prefs.gridThickness = e.target.value; this.savePreferences(); });
        prefInfiniteGrid.addEventListener('change', e => { this.prefs.infiniteGrid = e.target.checked; this.savePreferences(); });

        document.getElementById('btn-add-folder').addEventListener('click', () => this.createFolder());

        // Playback controller button events
        const btnPlay = document.getElementById('btn-anim-play');
        btnPlay.addEventListener('click', () => {
            if (this.isPlaying) {
                this.isPlaying = false;
                btnPlay.textContent = '▶';
            } else {
                this.isPlaying = true;
                btnPlay.textContent = '⏸';
                this.lastPlaybackTime = performance.now();
                this.playbackLoop();
            }
        });

        document.getElementById('btn-anim-first').addEventListener('click', () => this.updateFrame(this.startFrame));
        document.getElementById('btn-anim-last').addEventListener('click', () => this.updateFrame(this.endFrame));
        document.getElementById('btn-anim-prev').addEventListener('click', () => this.updateFrame(this.currentFrame - 1));
        document.getElementById('btn-anim-next').addEventListener('click', () => this.updateFrame(this.currentFrame + 1));

        const slider = document.getElementById('timeline-slider');
        slider.addEventListener('input', e => this.updateFrame(parseInt(e.target.value)));

        const autoKeyBtn = document.getElementById('btn-auto-key');
        autoKeyBtn.addEventListener('click', () => {
            this.isAutoKeyActive = !this.isAutoKeyActive;
            autoKeyBtn.style.background = this.isAutoKeyActive ? '#ff5555' : 'var(--bg-input)';
            autoKeyBtn.style.color = this.isAutoKeyActive ? '#ffffff' : '#ff5555';
        });

        // Numeric frame parameter configurations
        const animFpsInput = document.getElementById('anim-fps');
        animFpsInput.addEventListener('change', e => { this.prefs.animFps = parseInt(e.target.value); this.savePreferences(); });
        animFpsInput.value = this.prefs.animFps || 30;

        const animStartInput = document.getElementById('anim-start-frame');
        animStartInput.addEventListener('change', e => { this.startFrame = parseInt(e.target.value); slider.min = this.startFrame; });
        this.startFrame = parseInt(animStartInput.value);

        const animEndInput = document.getElementById('anim-end-frame');
        animEndInput.addEventListener('change', e => { this.endFrame = parseInt(e.target.value); slider.max = this.endFrame; });
        this.endFrame = parseInt(animEndInput.value);

        // View Through Camera Event listeners
        const toggleCameraView = (e) => {
            if (e) e.preventDefault();
            this.isViewingThroughCamera = !this.isViewingThroughCamera;
            this.updateCameraView();
        };
        document.getElementById('btn-camera-view').addEventListener('click', toggleCameraView);
        document.getElementById('sidebar-btn-cam-view').addEventListener('click', toggleCameraView);

        document.getElementById('cam-fov').addEventListener('input', e => {
            if (this.activeObject && this.activeObject.userData.isCamera) {
                const fov = parseFloat(e.target.value);
                this.activeObject.userData.camera.fov = fov;
                this.activeObject.userData.camera.updateProjectionMatrix();
                if (this.isAutoKeyActive) this.recordTransformKeyframe(this.activeObject);
            }
        });
        document.getElementById('cam-near').addEventListener('input', e => {
            if (this.activeObject && this.activeObject.userData.isCamera) {
                const near = parseFloat(e.target.value);
                this.activeObject.userData.camera.near = near;
                this.activeObject.userData.camera.updateProjectionMatrix();
            }
        });
        document.getElementById('cam-far').addEventListener('input', e => {
            if (this.activeObject && this.activeObject.userData.isCamera) {
                const far = parseFloat(e.target.value);
                this.activeObject.userData.camera.far = far;
                this.activeObject.userData.camera.updateProjectionMatrix();
            }
        });

        // Reference Image Slider/Input Property Event Listeners
        document.getElementById('ref-opacity').addEventListener('input', e => {
            if (this.activeObject && this.activeObject.userData.isReferenceImage) {
                const val = parseFloat(e.target.value);
                this.activeObject.userData.opacity = val;
                this.activeObject.material.uniforms.opacity.value = val;
                if (this.isAutoKeyActive) this.recordTransformKeyframe(this.activeObject);
            }
        });
        document.getElementById('ref-brightness').addEventListener('input', e => {
            if (this.activeObject && this.activeObject.userData.isReferenceImage) {
                const val = parseFloat(e.target.value);
                this.activeObject.userData.brightness = val;
                this.activeObject.material.uniforms.brightness.value = val;
            }
        });
        document.getElementById('ref-contrast').addEventListener('input', e => {
            if (this.activeObject && this.activeObject.userData.isReferenceImage) {
                const val = parseFloat(e.target.value);
                this.activeObject.userData.contrast = val;
                this.activeObject.material.uniforms.contrast.value = val;
            }
        });
        document.getElementById('ref-double-sided').addEventListener('change', e => {
            if (this.activeObject && this.activeObject.userData.isReferenceImage) {
                const checked = e.target.checked;
                this.activeObject.userData.doubleSided = checked;
                this.activeObject.material.side = checked ? THREE.DoubleSide : THREE.FrontSide;
                this.activeObject.material.needsUpdate = true;
            }
        });
        document.getElementById('ref-lock').addEventListener('change', e => {
            if (this.activeObject && this.activeObject.userData.isReferenceImage) {
                const checked = e.target.checked;
                this.activeObject.userData.isLocked = checked;
                if (checked) {
                    this.transformControl.detach();
                } else {
                    this.transformControl.attach(this.activeObject);
                }
            }
        });

        // Quick orientation align helpers for active reference sheet
        document.querySelectorAll('.ref-align-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.preventDefault();
                this.alignReference(btn.dataset.axis);
            });
        });

        // Standard context menu handler inside outliner tree for target selection
        const ctxMenu = document.getElementById('outliner-context-menu');
        let rightClickedCamera = null;

        document.getElementById('sidebar-outliner-section').addEventListener('contextmenu', e => {
            const outlinerItem = e.target.closest('.outliner-item');
            if (outlinerItem) {
                const uuid = outlinerItem.dataset.uuid;
                const child = this.scene.getObjectByProperty('uuid', uuid);
                if (child && child.userData.isCamera) {
                    e.preventDefault();
                    rightClickedCamera = child;
                    ctxMenu.style.left = `${e.clientX}px`;
                    ctxMenu.style.top = `${e.clientY}px`;
                    ctxMenu.classList.remove('hidden');
                }
            }
        });

        document.getElementById('context-set-active-camera').addEventListener('click', e => {
            e.preventDefault();
            if (rightClickedCamera) {
                this.activeSceneCamera = rightClickedCamera;
                this.showNotification(`Active render target set to: ${rightClickedCamera.name}`);
                this.updateOutliner();
            }
            ctxMenu.classList.add('hidden');
        });

        window.addEventListener('click', () => {
            ctxMenu.classList.add('hidden');
        });

        document.getElementById('menu-save-project').addEventListener('click', (e) => { e.preventDefault(); this.saveProject(); });
        document.getElementById('menu-load-project').addEventListener('click', (e) => { e.preventDefault(); document.getElementById('project-load-input').click(); });
        document.getElementById('project-load-input').addEventListener('change', (e) => {
            if (e.target.files[0]) this.loadProject(e.target.files[0]);
            e.target.value = '';
        });

        document.getElementById('menu-undo').addEventListener('click', (e) => { e.preventDefault(); this.undo(); });
        document.getElementById('menu-redo').addEventListener('click', (e) => { e.preventDefault(); this.redo(); });

        document.getElementById('menu-export-glb').addEventListener('click', (e) => {
            e.preventDefault();
            
            this.scene.traverse(child => {
                if (child.userData.isCameraHelperMesh) child.visible = false;
            });

            // ShaderMaterial is swapped with standard MeshBasicMaterial temporarily to allow native GLTF texturing serializations
            const swappedMaterials = [];
            this.scene.traverse(child => {
                if (child.userData.isReferenceImage && child.material.uniforms) {
                    const shaderMat = child.material;
                    const tempBasicMat = new THREE.MeshBasicMaterial({
                        map: shaderMat.uniforms.map.value,
                        opacity: shaderMat.uniforms.opacity.value,
                        transparent: true,
                        side: shaderMat.side
                    });
                    child.material = tempBasicMat;
                    swappedMaterials.push({ child, original: shaderMat });
                }
            });

            new GLTFExporter().parse(this.scene, (gltf) => {
                this.scene.traverse(child => {
                    if (child.userData.isCameraHelperMesh) child.visible = true;
                });
                swappedMaterials.forEach(item => { item.child.material = item.original; });

                const blob = new Blob([gltf], { type: 'application/octet-stream' });
                const link = document.createElement('a'); 
                link.style.display = 'none';
                link.href = URL.createObjectURL(blob); 
                link.download = 'scene.glb'; 
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            }, (err) => {
                this.scene.traverse(child => {
                    if (child.userData.isCameraHelperMesh) child.visible = true;
                });
                swappedMaterials.forEach(item => { item.child.material = item.original; });
                console.error(err);
            }, { binary: true, cameras: true });
        });

        document.getElementById('menu-export-obj').addEventListener('click', (e) => {
            e.preventDefault();
            this.scene.traverse(child => {
                if (child.userData.isCameraHelperMesh) child.visible = false;
            });
            const result = new OBJExporter().parse(this.scene);
            this.scene.traverse(child => {
                if (child.userData.isCameraHelperMesh) child.visible = true;
            });
            const blob = new Blob([result], { type: 'text/plain' });
            const link = document.createElement('a'); 
            link.style.display = 'none';
            link.href = URL.createObjectURL(blob); 
            link.download = 'scene.obj'; 
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });

        document.getElementById('menu-render-prev').addEventListener('click', (e) => { e.preventDefault(); this.executeRenderImage(false); });
        document.getElementById('menu-render-hd').addEventListener('click', (e) => { e.preventDefault(); this.executeRenderImage(true); });
        document.getElementById('menu-render-animation').addEventListener('click', (e) => { e.preventDefault(); this.exportAnimationMP4(); });

        document.getElementById('menu-import').addEventListener('click', (e) => { e.preventDefault(); document.getElementById('file-import-input').click(); });
        document.getElementById('file-import-input').addEventListener('change', (e) => { if (e.target.files[0]) this.handleImport(e.target.files[0]); e.target.value = ''; });

        document.getElementById('menu-import-reference').addEventListener('click', (e) => { e.preventDefault(); document.getElementById('image-import-input').click(); });
        document.getElementById('image-import-input').addEventListener('change', (e) => { if (e.target.files[0]) this.loadReferenceImage(e.target.files[0]); e.target.value = ''; });

        document.querySelectorAll('.add-mesh').forEach(el => el.addEventListener('click', e => { e.preventDefault(); this.addPrimitive(e.target.dataset.type); }));
        document.getElementById('menu-add-camera').addEventListener('click', (e) => { e.preventDefault(); this.addCameraObject(); });
        document.getElementById('menu-add-armature').addEventListener('click', (e) => { e.preventDefault(); this.createArmature(); });

        document.getElementById('menu-copy').addEventListener('click', () => { if(this.activeObject) this.clipboard = this.activeObject; });
        document.getElementById('menu-paste').addEventListener('click', () => {
            if(!this.clipboard) return;
            const clone = this.clipboard.clone(); clone.position.x += 0.5;
            if (this.clipboard.parent) this.clipboard.parent.add(clone); else this.scene.add(clone);
            
            if (clone.isMesh) this.objects.push(clone);
            else if (clone.userData.isCamera) this.objects.push(clone);
            else clone.traverse(child => { if(child.isMesh || child.userData.isCamera) this.objects.push(child); });
            
            this.pushHistory({
                type: 'create',
                uuid: clone.uuid,
                before: null,
                after: clone
            });

            this.selectObject(clone); this.updateOutliner();
        });
        document.getElementById('menu-select-all').addEventListener('click', () => { if (this.objects.length > 0) this.selectObject(this.objects[0]); });

        document.getElementById('obj-name').addEventListener('change', (e) => { if(this.activeObject) { this.activeObject.name = e.target.value; this.updateOutliner(); }});
        document.getElementById('obj-visible').addEventListener('change', (e) => { if(this.activeObject) this.activeObject.visible = e.target.checked; });
        document.getElementById('obj-wireframe').addEventListener('change', (e) => { if(this.activeObject && this.activeObject.material) this.activeObject.material.wireframe = e.target.checked; });
        document.getElementById('obj-shadow').addEventListener('change', (e) => { if(this.activeObject) { this.activeObject.castShadow = e.target.checked; this.activeObject.receiveShadow = e.target.checked; }});
        document.getElementById('obj-smooth').addEventListener('change', (e) => { if(this.activeObject && this.activeObject.material) { this.activeObject.material.flatShading = !e.target.checked; this.activeObject.material.needsUpdate = true; }});

        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tools = this.currentMode === 'sculpt' ? '.sculpt-tool' : '.obj-tool';
                document.querySelectorAll(tools).forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const tool = btn.dataset.tool;
                if (tool === 'select') this.transformControl.detach();
                if (tool === 'translate' && this.activeObject) { this.transformControl.setMode('translate'); this.transformControl.attach(this.activeObject); }
                if (tool === 'rotate' && this.activeObject) { this.transformControl.setMode('rotate'); this.transformControl.attach(this.activeObject); }
                if (tool === 'scale' && this.activeObject) { this.transformControl.setMode('scale'); this.transformControl.attach(this.activeObject); }
                if (tool && tool.startsWith('sculpt')) this.brushType = tool;
            });
        });

        const updateRad = (val) => { this.brushRadius = parseFloat(val); document.getElementById('top-radius').value = val; document.getElementById('side-radius').value = val; };
        document.getElementById('top-radius').addEventListener('input', e => updateRad(e.target.value));
        document.getElementById('side-radius').addEventListener('input', e => updateRad(e.target.value));

        const updateStr = (val) => { this.brushStrength = parseFloat(val); document.getElementById('top-strength').value = val; document.getElementById('side-strength').value = val; };
        document.getElementById('top-strength').addEventListener('input', e => updateStr(e.target.value));
        document.getElementById('side-strength').addEventListener('input', e => updateStr(e.target.value));

        document.getElementById('light-dir-int').addEventListener('input', e => this.lights.directional.intensity = parseFloat(e.target.value));
        document.getElementById('light-amb-int').addEventListener('input', e => this.lights.ambient.intensity = parseFloat(e.target.value));
        document.getElementById('light-shadows').addEventListener('change', e => { 
            this.renderer.shadowMap.enabled = e.target.checked; 
            this.scene.traverse(child => { if(child.isMesh) { child.castShadow = e.target.checked; child.receiveShadow = e.target.checked; }});
        });

        document.getElementById('mat-color').addEventListener('input', e => { if(this.activeObject && this.activeObject.material) this.activeObject.material.color.set(e.target.value); });
        document.getElementById('mat-roughness').addEventListener('input', e => { if(this.activeObject && this.activeObject.material) this.activeObject.material.roughness = parseFloat(e.target.value); });
        document.getElementById('mat-metallic').addEventListener('input', e => { if(this.activeObject && this.activeObject.material) this.activeObject.material.metalness = parseFloat(e.target.value); });
        document.getElementById('mat-emissive').addEventListener('input', e => { if(this.activeObject && this.activeObject.material) { this.activeObject.material.emissive.set(e.target.value); this.activeObject.material.emissiveIntensity = 1.0; }});
        document.getElementById('mat-opacity').addEventListener('input', e => { 
            if(this.activeObject && this.activeObject.material) {
                const val = parseFloat(e.target.value);
                this.activeObject.material.opacity = val;
                this.activeObject.material.transparent = val < 1.0;
                this.activeObject.material.needsUpdate = true;
            }
        });
        document.getElementById('mat-transmission').addEventListener('input', e => { 
            if(this.activeObject && this.activeObject.material && this.activeObject.material.transmission !== undefined) {
                this.activeObject.material.transmission = parseFloat(e.target.value);
                this.activeObject.material.needsUpdate = true;
            }
        });
        document.getElementById('mat-ior').addEventListener('input', e => { 
            if(this.activeObject && this.activeObject.material && this.activeObject.material.ior !== undefined) {
                this.activeObject.material.ior = parseFloat(e.target.value);
            }
        });
        document.getElementById('mat-iou').addEventListener('input', e => { 
            if(this.activeObject && this.activeObject.material && this.activeObject.material.userData) {
                const val = parseFloat(e.target.value);
                this.activeObject.material.userData.iou = val;
                this.activeObject.material.clearcoat = val; 
                this.activeObject.material.needsUpdate = true;
            }
        });

        // Drag-and-Drop Viewport triggers: Handles 3D importing and direct Reference Image drops
        const viewportContainer = document.getElementById('viewport');
        viewportContainer.addEventListener('dragover', (e) => e.preventDefault());
        viewportContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (!file) return;
            const ext = file.name.split('.').pop().toLowerCase();
            if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) {
                this.loadReferenceImage(file);
            } else {
                this.handleImport(file);
            }
        });
    }

    onWindowResize() {
        const container = document.getElementById('viewport');
        if(!container || !this.camera || !this.renderer) return;
        
        const aspect = container.clientWidth / container.clientHeight;
        this.camera.aspect = aspect;
        this.camera.updateProjectionMatrix();

        if (this.isViewingThroughCamera && this.activeCamera) {
            this.activeCamera.aspect = aspect;
            this.activeCamera.updateProjectionMatrix();
        }

        this.renderer.setSize(container.clientWidth, container.clientHeight);
    }

    playbackLoop() {
        if (!this.isPlaying) return;

        const now = performance.now();
        const delta = now - this.lastPlaybackTime;
        const interval = 1000 / (this.prefs.animFps || 30);

        if (delta >= interval) {
            this.lastPlaybackTime = now - (delta % interval);
            let nextFrame = this.currentFrame + 1;
            if (nextFrame > this.endFrame) {
                nextFrame = this.startFrame;
            }
            this.updateFrame(nextFrame);
        }

        requestAnimationFrame(() => this.playbackLoop());
    }

    // --- 📸 CAMERA-AWARE RENDER SYSTEM ---
    executeRenderImage(isHD) {
        let activeCam = null;
        const sourcePref = this.prefs.renderCameraSource || "active_scene_camera";

        if (sourcePref === "active_scene_camera") {
            if (this.activeSceneCamera && this.activeSceneCamera.userData.isCamera) {
                activeCam = this.activeSceneCamera.userData.camera;
                this.showNotification("Render Source: [Scene Camera]");
            } else {
                this.showNotification("No active camera found. Using current viewport instead.");
                activeCam = this.camera;
            }
        } else {
            this.showNotification("Render Source: [Current View]");
            activeCam = this.isViewingThroughCamera && this.activeCamera ? this.activeCamera : this.camera;
        }

        // Delay execution slightly so notification banner is fully rendered on screen before capturing canvas buffer
        setTimeout(() => {
            this.renderImageFrame(isHD, activeCam);
        }, 100);
    }

    renderImageFrame(isHD, targetCamera) {
        const wasGridVisible = this.grid.visible;
        this.grid.visible = false;
        
        let attachedObj = null;
        if(this.transformControl.object) {
            attachedObj = this.transformControl.object;
            this.transformControl.detach();
        }

        this.scene.traverse(child => {
            if (child.userData.isCameraHelperMesh) child.visible = false;
        });

        const origRatio = this.renderer.getPixelRatio();
        if(isHD) this.renderer.setPixelRatio(origRatio * 2);

        this.renderer.render(this.scene, targetCamera);
        const dataURL = this.renderer.domElement.toDataURL('image/png');
        
        if(isHD) {
            this.renderer.setPixelRatio(origRatio);
            this.renderer.render(this.scene, targetCamera);
        }
        
        this.grid.visible = wasGridVisible;
        
        this.scene.traverse(child => {
            if (child.userData.isCameraHelperMesh && !this.isViewingThroughCamera) child.visible = true;
        });

        if(attachedObj) {
            this.transformControl.attach(attachedObj);
        }

        const link = document.createElement('a');
        link.style.display = 'none';
        link.href = dataURL;
        link.download = `render_${new Date().getTime()}.png`;
        
        // Append anchor strictly to document body to trigger download context safely
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // --- 🎞️ CLIENT-SIDE MP4 VIDEO EXPORT ---
    exportAnimationMP4() {
        let activeCam = null;
        const sourcePref = this.prefs.renderCameraSource || "active_scene_camera";
        if (sourcePref === "active_scene_camera" && this.activeSceneCamera) {
            activeCam = this.activeSceneCamera.userData.camera;
        } else {
            activeCam = this.camera;
        }

        this.showNotification("Processing frames for MP4 export...");

        // Store active visibility states
        const wasGridVisible = this.grid.visible;
        this.grid.visible = false;
        this.scene.traverse(child => {
            if (child.userData.isCameraHelperMesh) child.visible = false;
        });

        // Temporarily detach transform control gizmo from active object
        let attachedObj = null;
        if(this.transformControl.object) {
            attachedObj = this.transformControl.object;
            this.transformControl.detach();
        }

        // Set up client-side MediaRecorder captureStream stream context
        const fps = this.prefs.animFps || 30;
        const stream = this.renderer.domElement.captureStream(fps);
        
        let options = { mimeType: 'video/webm;codecs=vp9' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options = { mimeType: 'video/webm' };
        }

        const chunks = [];
        const recorder = new MediaRecorder(stream, options);
        
        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = () => {
            const blob = new Blob(chunks, { type: 'video/mp4' });
            const link = document.createElement('a');
            link.style.display = 'none';
            link.href = URL.createObjectURL(blob);
            link.download = `render_${new Date().getTime()}.mp4`;
            
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            // Restore active viewport properties and entities
            this.grid.visible = wasGridVisible;
            this.scene.traverse(child => {
                if (child.userData.isCameraHelperMesh && !this.isViewingThroughCamera) child.visible = true;
            });
            if(attachedObj) {
                this.transformControl.attach(attachedObj);
            }
            this.showNotification("Animation Export Complete!");
        };

        recorder.start();

        // Perform programmatic, frame-by-frame canvas rendering loop matching target intervals
        let currentF = this.startFrame;
        const frameInterval = 1000 / fps;

        const processFrameStep = () => {
            if (currentF > this.endFrame) {
                recorder.stop();
                return;
            }
            this.updateFrame(currentF);
            this.renderer.render(this.scene, activeCam);
            currentF++;
            setTimeout(processFrameStep, frameInterval);
        };

        processFrameStep();
    }

    render() {
        this.orbit.update();

        // 🌐 Infinite Grid Mode: Shift helper position horizontally under camera projections
        if (this.prefs.infiniteGrid && this.grid) {
            this.grid.position.x = Math.round(this.camera.position.x / 10) * 10;
            this.grid.position.z = Math.round(this.camera.position.z / 10) * 10;
        } else if (this.grid) {
            this.grid.position.set(0, -0.01, 0);
        }

        const renderingCam = this.isViewingThroughCamera && this.activeCamera ? this.activeCamera : this.camera;
        this.renderer.render(this.scene, renderingCam);
    }
}

try {
    const app = new WebBlend();
    window.__webblend = app;
} catch (e) {
    console.error('[WebBlend] Init error:', e);
    document.getElementById('loading').textContent = 'Error: ' + e.message;
    document.getElementById('loading').style.background = '#aa0000b3';
}