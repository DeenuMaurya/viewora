/* =========================================================
   VIEWER CORE — shared by viewer.html (public, read-only) and
   editor.html (owner, can add/remove/save rooms).

   Usage:
     ViewerCore.boot({
       canvas, modelUrl, rooms: [{label,x,y,z}, ...],
       start: {x,y,z,rx,ry,rz} | null,    // where the visitor spawns; null = auto
       editable: true|false,
       onRoomsChanged: (rooms) => {...},  // called after add/delete in edit mode
       onStartChanged: (start) => {...}   // called after the start position is edited
     });
   ========================================================= */
window.ViewerCore = (function () {
  const EYE_HEIGHT = 1.5;
  const RAD_TO_DEG = 180 / Math.PI;
  const DEG_TO_RAD = Math.PI / 180;

  function boot(config) {
    const canvas = config.canvas;
    const editable = !!config.editable;
    const asNumber = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    // rx/ry/rz are pitch/yaw/roll in radians, matching camera.rotation.
    let HOTSPOTS = (config.rooms || []).map((r) => ({
      position: new BABYLON.Vector3(r.x, r.y, r.z),
      label: r.label,
      rx: asNumber(r.rx),
      ry: asNumber(r.ry),
      rz: asNumber(r.rz)
    }));

    // Author-chosen spawn point, or null to fall back to the first room / the
    // model centre. Same shape as a room so the same helpers work on it.
    let START = toRoomLike(config.start);

    function toRoomLike(s) {
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) return null;
      return {
        position: new BABYLON.Vector3(s.x, s.y, s.z),
        rx: asNumber(s.rx),
        ry: asNumber(s.ry),
        rz: asNumber(s.rz)
      };
    }

    const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    const scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0.07, 0.08, 0.1, 1);

    // ---- Lighting ----
    // A HemisphericLight lights surfaces facing its direction with `diffuse`
    // and surfaces facing the OPPOSITE way with `groundColor`. With the
    // direction set to (0,1,0), a ceiling — whose normal points down, into the
    // room — receives exactly groundColor, and that defaults to pure black.
    // The downward `sun` misses ceilings too, so interiors rendered with a
    // solid black roof. Setting a ground bounce colour is the actual fix: it
    // stands in for light reflecting off the floor, which is what stops real
    // ceilings from being black.
    const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
    hemi.intensity = 0.9;
    hemi.groundColor = new BABYLON.Color3(0.5, 0.52, 0.58);
    const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-1, -2, -1), scene);
    sun.intensity = 1.2;
    // Weak upward fill so ceilings and other down-facing surfaces get some
    // shading variation instead of reading as one flat grey panel.
    const fill = new BABYLON.DirectionalLight("fill", new BABYLON.Vector3(0.4, 1, 0.6), scene);
    fill.intensity = 0.35;

    const ground = BABYLON.MeshBuilder.CreateGround("ground", { width: 60, height: 60 }, scene);
    const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new BABYLON.Color3(0.5, 0.5, 0.5);
    ground.material = groundMat;

    const walkCamera = new BABYLON.UniversalCamera("walkCam", new BABYLON.Vector3(0, 1.7, -5), scene);
    walkCamera.minZ = 0.05;
    walkCamera.angularSensibility = 3200;
    // Built-in keyboard input is removed — walking is handled by the custom
    // WASD block further down, which works without canvas focus, is
    // frame-rate independent, and moves on the floor plane instead of into it.
    walkCamera.inputs.removeByType("FreeCameraKeyboardMoveInput");
    // `inertia` is left at its default because it damps cameraRotation, which
    // is what gives mouse-look its smooth glide. It no longer affects walking
    // at all, since we write walkCamera.position directly (see below).
    //
    // Babylon's own collision (checkCollisions + applyGravity + ellipsoid) is
    // deliberately NOT used for the player. It resolves movement against an
    // ellipsoid whose lower half is a curve and which has no notion of a
    // maximum step height, so any waist-high obstacle — a bed, a sofa, a
    // kitchen counter — gets smoothly climbed instead of blocked, and gravity
    // then slides you down the curve ("skiing"). The controller below does
    // explicit raycast collision with a hard step-height limit instead.
    walkCamera.checkCollisions = false;
    walkCamera.applyGravity = false;

    // Single unified first-person camera — there are no orbit/top modes.
    // The visitor is always "in" the space: drag to look, click the floor to
    // travel there, WASD/arrows to walk.
    scene.activeCamera = walkCamera;
    walkCamera.attachControl(canvas, true);

    let modelCenter = null,
      modelMin = null,
      modelMax = null;
    let loadedMeshes = [];

    let selectedRoomIndex = null; // which view the inspector is editing
    let moveAnim = null;

    function computeBounds(meshes) {
      let min = null,
        max = null;
      meshes.forEach((m) => {
        const info = m.getBoundingInfo?.();
        if (!info) return;
        const bMin = info.boundingBox.minimumWorld;
        const bMax = info.boundingBox.maximumWorld;
        min = min ? BABYLON.Vector3.Minimize(min, bMin) : bMin.clone();
        max = max ? BABYLON.Vector3.Maximize(max, bMax) : bMax.clone();
      });
      return { min, max };
    }

    async function loadModel(url) {
      showLoading(true);
      try {
        const result = await BABYLON.SceneLoader.ImportMeshAsync("", "", url, scene, updateLoadingProgress);
        loadedMeshes = result.meshes;
        // Architectural models are static, but skip these optimisations if
        // the file actually ships animations or skinning — freezing would
        // pin those meshes in place.
        const isStatic = (result.animationGroups || []).length === 0 && (result.skeletons || []).length === 0;
        result.meshes.forEach((m) => {
          // The walk controller raycasts against these meshes every frame.
          // On a dense architectural mesh a ray would otherwise be tested
          // against tens of thousands of triangles; a submesh octree narrows
          // it to the triangles the ray actually passes near.
          if (m.getTotalVertices && m.getTotalVertices() > 0 && m.createOrUpdateSubmeshesOctree) {
            try {
              m.createOrUpdateSubmeshesOctree(64, 2);
            } catch (e) {
              /* octree is an optimisation, not a requirement */
            }
          }
          if (isStatic) {
            m.freezeWorldMatrix(); // nothing moves, so stop recomputing it
            m.material?.freeze(); // and stop re-evaluating shader state
          }
        });

        const { min, max } = computeBounds(result.meshes);
        if (min && max) {
          modelMin = min;
          modelMax = max;
          modelCenter = min.add(max).scale(0.5);
          ground.setEnabled(false);

          if (HOTSPOTS.length > 0) selectedRoomIndex = 0;
          refreshRoomUI();
          spawnAtStart();
        }
      } catch (err) {
        console.error("Model load failed:", err);
        if (config.onLoadError) config.onLoadError(err);
      } finally {
        showLoading(false);
      }
    }

    function showLoading(state) {
      const el = document.getElementById("loadingScreen");
      if (!el) return;
      const fill = document.getElementById("loaderFill");
      if (state) {
        el.classList.remove("hidden");
        if (fill) fill.style.width = "0%";
      } else {
        if (fill) fill.style.width = "100%";
        setTimeout(() => el.classList.add("hidden"), 250);
      }
    }

    // Babylon passes browser download events here. A computable content length
    // gives visitors honest progress instead of an artificial loading timer.
    function updateLoadingProgress(event) {
      const fill = document.getElementById("loaderFill");
      const label = document.querySelector("#loadingScreen .loader-label");
      if (!fill) return;
      if (event && event.lengthComputable && event.total > 0) {
        const percent = Math.min(95, Math.round((event.loaded / event.total) * 100));
        fill.style.width = `${percent}%`;
        if (label) label.textContent = `Loading model ${percent}%`;
      } else if (label) {
        label.textContent = "Loading model";
      }
    }

    function findFloorY(x, z) {
      if (!modelMax || !modelMin) return null;
      const rayStart = new BABYLON.Vector3(x, modelMax.y + 10, z);
      const rayLength = modelMax.y - modelMin.y + 20;
      const ray = new BABYLON.Ray(rayStart, new BABYLON.Vector3(0, -1, 0), rayLength);
      const hits = scene.multiPickWithRay(
        ray,
        (mesh) => mesh.name !== "ground" && loadedMeshes.includes(mesh)
      );
      if (!hits || hits.length === 0) return null;
      const floorHits = hits.filter((h) => {
        if (!h.hit || !h.pickedPoint) return false;
        const normal = h.getNormal(true, true);
        return normal && normal.y > 0.7;
      });
      if (floorHits.length === 0) return null;
      floorHits.sort((a, b) => b.distance - a.distance);
      return floorHits[0].pickedPoint.y;
    }

    function isSolid(mesh) {
      return loadedMeshes.includes(mesh) || (mesh === ground && ground.isEnabled());
    }

    // Height of the first walkable (upward-facing) surface at or below fromY.
    // Unlike findFloorY, which always returns the LOWEST floor in the model,
    // this returns the surface the player is actually standing on — which is
    // what stairs and split levels need.
    function surfaceHeightAt(x, z, fromY) {
      const down = new BABYLON.Vector3(0, -1, 0);
      const length = fromY - (modelMin ? modelMin.y : 0) + 5;
      const ray = new BABYLON.Ray(new BABYLON.Vector3(x, fromY, z), down, length);
      const hits = scene.multiPickWithRay(ray, isSolid);
      if (!hits || hits.length === 0) return null;
      let best = null;
      for (const h of hits) {
        if (!h.hit || !h.pickedPoint) continue;
        const n = h.getNormal(true, true);
        if (!n || n.y < 0.6) continue; // a wall or ceiling, not something to stand on
        if (!best || h.pickedPoint.y > best) best = h.pickedPoint.y;
      }
      return best;
    }

    // Horizontal blocker in the given direction, or null. Returns the surface
    // normal so the caller can slide along the wall instead of stopping dead.
    function wallNormalAt(x, y, z, dirX, dirZ, distance) {
      const ray = new BABYLON.Ray(new BABYLON.Vector3(x, y, z), new BABYLON.Vector3(dirX, 0, dirZ), distance);
      const hit = scene.pickWithRay(ray, isSolid);
      if (!hit || !hit.hit || !hit.pickedPoint) return null;
      return hit.getNormal(true, true);
    }

    // Place the player instantly (no travel animation) at an exact feet height.
    // Callers decide where that height comes from — this deliberately does no
    // floor snapping of its own, so an authored height is never overridden.
    function placePlayer(x, z, feetY, rotation) {
      walkCamera.position = new BABYLON.Vector3(x, feetY + EYE_HEIGHT, z);
      walkCamera.rotation.set(rotation.x || 0, rotation.y || 0, rotation.z || 0);
      targetFeetY = feetY; // don't let the floor-follow ease drag us back
    }

    // Feet height for a room: whatever was authored, falling back to the floor
    // (and then the model's base) only when the room carries no usable Y.
    function roomFeetY(h) {
      if (Number.isFinite(h.position.y)) return h.position.y;
      const floorY = findFloorY(h.position.x, h.position.z);
      if (floorY !== null) return floorY;
      return modelMin ? modelMin.y : 0;
    }

    function spawnAtCenter() {
      if (!modelCenter) return;
      // No authored position here, so the floor genuinely is the right source.
      const floorY = findFloorY(modelCenter.x, modelCenter.z);
      placePlayer(
        modelCenter.x,
        modelCenter.z,
        floorY !== null ? floorY : modelMin.y,
        BABYLON.Vector3.Zero()
      );
    }

    function spawnAtRoom(h) {
      placePlayer(h.position.x, h.position.z, roomFeetY(h), roomRotation(h));
    }

    // Drop the visitor into the space on load. Priority: the author's explicit
    // start position, then the first room (a chosen viewpoint still beats the
    // raw bounding-box centre, which can land inside a wall), then the centre.
    function spawnAtStart() {
      if (START) spawnAtRoom(START);
      else if (HOTSPOTS.length > 0) spawnAtRoom(HOTSPOTS[0]);
      else spawnAtCenter();
    }

    function roomRotation(h) {
      return new BABYLON.Vector3(h.rx || 0, h.ry || 0, h.rz || 0);
    }

    // Snap the camera to a room instantly. Used for the inspector's live
    // preview, where the point is to see the edit as it is typed rather than
    // to watch a two-second glide.
    function previewRoom(h) {
      stopTour(); // editing a view shouldn't fight a playing tour
      moveAnim = null; // a running travel animation would overwrite us
      stopWalking();
      walkCamera.position.copyFromFloats(h.position.x, h.position.y + EYE_HEIGHT, h.position.z);
      walkCamera.rotation.set(h.rx || 0, h.ry || 0, h.rz || 0);
      targetFeetY = h.position.y;
    }

    // ---- Custom WASD / arrow-key walking ----
    // Replaces Babylon's built-in keyboard input because the built-in one:
    //  1. Only fires while the <canvas> has DOM focus — after clicking the
    //     Walk/Orbit/Top buttons, focus sits on the button and the keys
    //     appear completely dead. Listening on window fixes that.
    //  2. Moves a fixed amount per FRAME, so walk speed changes with your
    //     monitor's refresh rate. Here everything is scaled by real elapsed
    //     time (deltaTime), so speed is consistent everywhere.
    //  3. Moves along where the camera *points*, including pitch — look down,
    //     press W, and you shove yourself into the floor while collision
    //     shoves back (visible as jitter). Here movement is projected onto
    //     the horizontal plane using the camera's yaw only.
    const MOVE_KEYS = new Set([
      "KeyW",
      "KeyA",
      "KeyS",
      "KeyD",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight"
    ]);
    const MOVE_ACCELERATION = 12; // how quickly we reach full speed / stop (higher = snappier)
    // EYE_HEIGHT of 1.5 means this codebase already assumes the model is in
    // metres, so walking speed is a real-world constant rather than something
    // derived from the model's size — a big building shouldn't turn the
    // visitor into a sprinter. Long distances are what click-to-travel and
    // the room buttons are for; Shift covers the impatient case.
    const WALK_SPEED = 1.8; // metres/second — an unhurried real walking pace
    const SPRINT_MULTIPLIER = 2.4;

    // ---- Collision shape ----
    // STEP_HEIGHT is the whole point: anything taller than this is a wall you
    // stop at, anything shorter is a step you walk up. At 0.35m a doorsill or
    // a stair tread is traversable but a 0.5m bed is not, which is what stops
    // the player climbing onto furniture.
    const PLAYER_RADIUS = 0.3;
    const STEP_HEIGHT = 0.35;
    // Heights (above the player's feet) at which we probe for walls. The
    // lowest sits just above STEP_HEIGHT so the two rules can't disagree:
    // if a ray hits it, it was too tall to step onto anyway.
    const WALL_PROBE_HEIGHTS = [STEP_HEIGHT + 0.05, 0.9, EYE_HEIGHT - 0.1];
    const FLOOR_FOLLOW = 14; // how quickly the eye settles to a new floor height

    const pressedKeys = new Set();
    let sprinting = false;
    let walkVelocity = BABYLON.Vector3.Zero();
    let targetFeetY = null; // floor height the eye is easing toward

    function isTypingTarget(target) {
      return (
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      );
    }

    window.addEventListener("keydown", (e) => {
      if (isTypingTarget(e.target)) return;
      sprinting = e.shiftKey;
      if (!MOVE_KEYS.has(e.code)) return;
      pressedKeys.add(e.code);
      stopTour(); // taking manual control ends the guided tour
      // A movement key takes over from any click-to-walk animation — without
      // this, the animation keeps overwriting the camera position for up to
      // ~2s after every click and the keys feel dead during that time.
      if (moveAnim) {
        moveAnim = null;
        targetFeetY = walkCamera.position.y - EYE_HEIGHT;
      }
      e.preventDefault(); // keep arrow keys from scrolling the page
    });
    window.addEventListener("keyup", (e) => {
      pressedKeys.delete(e.code);
      sprinting = e.shiftKey;
    });
    window.addEventListener("blur", stopWalking); // alt-tab safety: no keys stuck "down"

    function updateWalkMovement(dt) {
      const yaw = walkCamera.rotation.y;
      const fx = Math.sin(yaw),
        fz = Math.cos(yaw); // forward on the floor plane
      let mx = 0,
        mz = 0;
      if (pressedKeys.has("KeyW") || pressedKeys.has("ArrowUp")) {
        mx += fx;
        mz += fz;
      }
      if (pressedKeys.has("KeyS") || pressedKeys.has("ArrowDown")) {
        mx -= fx;
        mz -= fz;
      }
      if (pressedKeys.has("KeyD") || pressedKeys.has("ArrowRight")) {
        mx += fz;
        mz -= fx;
      }
      if (pressedKeys.has("KeyA") || pressedKeys.has("ArrowLeft")) {
        mx -= fz;
        mz += fx;
      }

      const length = Math.hypot(mx, mz);
      const speed = WALK_SPEED * (sprinting ? SPRINT_MULTIPLIER : 1);
      const targetX = length > 0 ? (mx / length) * speed : 0;
      const targetZ = length > 0 ? (mz / length) * speed : 0;

      // Exponential smoothing toward the target velocity — soft start/stop
      // instead of instant full-speed jerks. Frame-rate independent.
      const blend = 1 - Math.exp(-MOVE_ACCELERATION * dt);
      walkVelocity.x += (targetX - walkVelocity.x) * blend;
      walkVelocity.z += (targetZ - walkVelocity.z) * blend;

      // Standing completely still — skip the raycasts entirely.
      if (length === 0 && Math.abs(walkVelocity.x) < 1e-3 && Math.abs(walkVelocity.z) < 1e-3) {
        walkVelocity.setAll(0);
        return;
      }

      const pos = walkCamera.position;
      const feetY = pos.y - EYE_HEIGHT;
      let dx = walkVelocity.x * dt;
      let dz = walkVelocity.z * dt;

      // ---- Slide along walls ----
      // Two passes so that sliding into a corner resolves against both walls
      // instead of squeezing through the seam.
      for (let pass = 0; pass < 2; pass++) {
        const moveLen = Math.hypot(dx, dz);
        if (moveLen < 1e-6) {
          dx = 0;
          dz = 0;
          break;
        }
        const dirX = dx / moveLen,
          dirZ = dz / moveLen;

        let normal = null;
        for (const h of WALL_PROBE_HEIGHTS) {
          normal = wallNormalAt(pos.x, feetY + h, pos.z, dirX, dirZ, moveLen + PLAYER_RADIUS);
          if (normal) break;
        }
        if (!normal) break;

        // Project the movement onto the wall plane, using only the wall's
        // horizontal facing so a sloped surface can't launch us upward.
        const nLen = Math.hypot(normal.x, normal.z);
        if (nLen < 1e-6) {
          dx = 0;
          dz = 0;
          break;
        } // floor/ceiling-facing: nowhere to slide
        const nx = normal.x / nLen,
          nz = normal.z / nLen;
        const into = dx * nx + dz * nz;
        if (into >= 0) break; // already moving away from this wall
        dx -= nx * into;
        dz -= nz * into;
      }

      // ---- Floor check with a hard step limit ----
      const nextX = pos.x + dx,
        nextZ = pos.z + dz;
      if (dx !== 0 || dz !== 0) {
        // Probe from just above the highest step we're willing to climb, so
        // anything taller simply isn't seen as ground.
        const surface = surfaceHeightAt(nextX, nextZ, feetY + STEP_HEIGHT + 0.05);
        // No ground ahead (an open edge or a hole) — refuse rather than walk
        // out into empty space.
        if (surface !== null) {
          pos.x = nextX;
          pos.z = nextZ;
          targetFeetY = surface;
        } else {
          walkVelocity.setAll(0);
        }
      }

      // Ease the eye toward the floor height instead of snapping, so stairs
      // and thresholds glide rather than pop.
      if (targetFeetY !== null) {
        const eyeTarget = targetFeetY + EYE_HEIGHT;
        pos.y += (eyeTarget - pos.y) * (1 - Math.exp(-FLOOR_FOLLOW * dt));
      }
    }

    function stopWalking() {
      pressedKeys.clear();
      sprinting = false;
      walkVelocity.setAll(0);
    }

    function shortestAngleDiff(from, to) {
      let diff = (to - from) % (Math.PI * 2);
      if (diff > Math.PI) diff -= Math.PI * 2;
      if (diff < -Math.PI) diff += Math.PI * 2;
      return diff;
    }

    function goToRoom(h, onArrive) {
      // The authored Y wins. It used to be the other way round — the floor
      // raycast took priority and the saved Y was only a fallback for when the
      // ray missed — which silently discarded any hand-typed height, so an
      // elevated "top view" always snapped back down to floor level. The floor
      // is now only consulted when the room has no usable Y at all.
      const targetY = roomFeetY(h) + EYE_HEIGHT;
      const target = new BABYLON.Vector3(h.position.x, targetY, h.position.z);
      const fromRot = walkCamera.rotation.clone();
      const wanted = roomRotation(h);
      // Take the shortest way round on every axis, so a turn from 350° to 10°
      // is a 20° nudge rather than a 340° spin.
      const toRot = new BABYLON.Vector3(
        fromRot.x + shortestAngleDiff(fromRot.x, wanted.x),
        fromRot.y + shortestAngleDiff(fromRot.y, wanted.y),
        fromRot.z + shortestAngleDiff(fromRot.z, wanted.z)
      );
      moveAnim = {
        from: walkCamera.position.clone(),
        to: target,
        fromRot,
        toRot,
        startTime: performance.now(),
        duration: Math.min(2200, Math.max(500, BABYLON.Vector3.Distance(walkCamera.position, target) * 300)),
        onArrive
      };
    }

    let pointerDownPos = null;
    const activePointers = new Set();

    function pickAtClientPoint(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * engine.getRenderWidth();
      const y = ((clientY - rect.top) / rect.height) * engine.getRenderHeight();
      return scene.pick(x, y, (mesh) => loadedMeshes.includes(mesh));
    }

    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture?.(e.pointerId);
      activePointers.add(e.pointerId);
      // A second finger is never a floor tap. Mobile has no pinch zoom;
      // one-finger drag remains the rotation control.
      if (activePointers.size > 1) pointerDownPos = null;
      else pointerDownPos = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      stopTour(); // dragging to look or clicking to walk ends the tour
    });

    canvas.addEventListener("pointerup", (e) => {
      const wasSingleTap =
        pointerDownPos && pointerDownPos.pointerId === e.pointerId && activePointers.size === 1;
      activePointers.delete(e.pointerId);
      if (!wasSingleTap) return;
      const dx = e.clientX - pointerDownPos.x;
      const dy = e.clientY - pointerDownPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      pointerDownPos = null;
      if (dist > 6) return;

      const pick = pickAtClientPoint(e.clientX, e.clientY);
      if (!pick || !pick.hit || !pick.pickedPoint) return;
      const floorY = findFloorY(pick.pickedPoint.x, pick.pickedPoint.z);
      if (floorY === null) return;
      // Only travel when the clicked surface really is the floor. Clicking a
      // bed or a countertop otherwise teleported the player to floor level
      // *inside* that object.
      if (pick.pickedPoint.y > floorY + STEP_HEIGHT) return;
      const target = new BABYLON.Vector3(pick.pickedPoint.x, floorY + EYE_HEIGHT, pick.pickedPoint.z);
      stopWalking();
      showMoveMarker(e.clientX, e.clientY);
      // A floor tap selects a destination, not a look direction. Move the
      // player directly while preserving the current camera rotation so a
      // mobile tap never becomes an unexpected pan or turn.
      moveAnim = null;
      walkCamera.position.copyFrom(target);
      targetFeetY = floorY;
    });

    function showMoveMarker(x, y) {
      const marker = document.getElementById("moveMarker");
      if (!marker) return;
      marker.style.left = x + "px";
      marker.style.top = y + "px";
      marker.classList.remove("show");
      void marker.offsetWidth;
      marker.classList.add("show");
    }

    function easeInOutQuad(t) {
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    scene.onBeforeRenderObservable.add(() => {
      // Clamped: after a tab-switch or a long frame hitch, an unclamped dt
      // would teleport the player a huge distance in one step.
      const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
      if (moveAnim) {
        const elapsed = performance.now() - moveAnim.startTime;
        const t = Math.min(elapsed / moveAnim.duration, 1);
        const eased = easeInOutQuad(t);
        walkCamera.position = BABYLON.Vector3.Lerp(moveAnim.from, moveAnim.to, eased);
        if (moveAnim.fromRot) {
          BABYLON.Vector3.LerpToRef(moveAnim.fromRot, moveAnim.toRot, eased, walkCamera.rotation);
        }
        if (t >= 1) {
          const arrived = moveAnim.onArrive;
          moveAnim = null;
          // Hand the floor-follow ease a matching target, or it would
          // immediately pull the eye back off the point we just travelled to.
          targetFeetY = walkCamera.position.y - EYE_HEIGHT;
          // Read from the local copy: the callback may start the next leg of a
          // tour, and clearing moveAnim first stops that from being wiped out.
          if (arrived) arrived();
        }
      } else {
        updateWalkMovement(dt);
      }
      updateHotspots();
    });

    function buildHotspotDOM() {
      const layer = document.getElementById("hotspotLayer");
      if (!layer) return;
      layer.innerHTML = "";
    }

    function updateHotspots() {
      const activeCam = scene.activeCamera;
      HOTSPOTS.forEach((h, i) => {
        const el = document.getElementById("hotspot-" + i);
        if (!el) return;
        const coords = BABYLON.Vector3.Project(
          h.position,
          BABYLON.Matrix.Identity(),
          scene.getTransformMatrix(),
          activeCam.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight())
        );
        if (coords.z > 0 && coords.z < 1) {
          el.style.display = "block";
          el.style.left = coords.x + "px";
          el.style.top = coords.y + "px";
        } else {
          el.style.display = "none";
        }
      });
    }

    function formatNumber(value, decimals = 2) {
      if (!Number.isFinite(value)) return "0.00";
      return value.toFixed(decimals);
    }

    function getPlayerFloorPosition() {
      return new BABYLON.Vector3(
        walkCamera.position.x,
        walkCamera.position.y - EYE_HEIGHT,
        walkCamera.position.z
      );
    }

    function emitRoomsChanged() {
      if (config.onRoomsChanged) config.onRoomsChanged(exportRooms());
    }

    // Read-only room navigation, identical in the viewer and the editor. All
    // room *editing* lives in the inspector panel; this panel used to carry a
    // duplicate set of X/Z/Rot inputs that could only write a subset of the
    // fields (no Y, no rotation X/Z) and silently re-derived Y from the floor,
    // undoing whatever the inspector had set. Keeping it read-only means the
    // editor shows exactly what a visitor sees.
    function buildRoomsPanel() {
      const list = document.getElementById("roomsList");
      const panel = document.getElementById("roomsPanel");
      if (!list || !panel) return;
      list.innerHTML = "";
      if (HOTSPOTS.length === 0) {
        const empty = document.createElement("div");
        empty.className = "rooms-panel-empty";
        empty.textContent = "No rooms defined for this project.";
        list.appendChild(empty);
      } else {
        HOTSPOTS.forEach((h, i) => {
          const btn = document.createElement("button");
          btn.className = "room-btn";
          btn.textContent = h.label;
          btn.addEventListener("click", () => {
            stopTour(); // picking a room by hand takes over from the tour
            highlightRoom(i);
            goToRoom(h);
          });
          list.appendChild(btn);
        });
      }
      panel.classList.toggle("show", HOTSPOTS.length > 0);
      applyRoomHighlight(); // the buttons were just rebuilt
      updateTourButton(); // a project can go from 1 to 2 views while editing
    }

    /* ---------------------------------------------------------------
       GUIDED TOUR
       Walks the views in order — Kitchen -> Hall -> Room — pausing at
       each one and highlighting the matching room button. Any manual
       input (a key, a drag, a click) cancels it, so the visitor is
       never fighting the camera for control.
       --------------------------------------------------------------- */
    const TOUR_DWELL_MS = 2600; // time spent looking at each view before moving on
    let tourActive = false;
    let tourIndex = -1;
    let tourTimer = null;
    let activeRoomIndex = null;

    function applyRoomHighlight() {
      const list = document.getElementById("roomsList");
      if (!list) return;
      list.querySelectorAll(".room-btn").forEach((btn, i) => {
        btn.classList.toggle("active", i === activeRoomIndex);
      });
      // The panel scrolls once there are more views than fit, so keep the
      // highlighted one visible instead of letting the tour run off-screen.
      if (activeRoomIndex !== null) {
        const current = list.querySelectorAll(".room-btn")[activeRoomIndex];
        if (current && current.scrollIntoView) current.scrollIntoView({ block: "nearest" });
      }
    }

    function highlightRoom(i) {
      activeRoomIndex = i;
      applyRoomHighlight();
    }

    function updateTourButton() {
      const btn = document.getElementById("btnPlayTour");
      if (!btn) return;
      // A "tour" of one view is just a jump, so only offer it from two up.
      btn.style.display = HOTSPOTS.length >= 2 ? "" : "none";
      // The play/stop icons are both in the DOM as SVG; CSS shows the right one
      // off this class, so there's no icon markup to swap here.
      btn.classList.toggle("playing", tourActive);
      const label = btn.querySelector(".tour-label");
      if (label) label.textContent = tourActive ? "Stop tour" : "Play tour";
      btn.title = tourActive ? "Stop the guided tour" : "Visit every view in order";
    }

    function startTour() {
      if (HOTSPOTS.length < 2 || tourActive) return;
      tourActive = true;
      tourIndex = -1;
      stopWalking(); // a held key would fight the travel animation
      updateTourButton();
      tourNext();
    }

    function tourNext() {
      if (!tourActive) return;
      tourIndex += 1;
      // Re-read the array every step rather than snapshotting it: in the editor
      // a view can be deleted while the tour is mid-flight, and indexing past
      // the end would otherwise throw inside goToRoom.
      const h = HOTSPOTS[tourIndex];
      if (!h) {
        stopTour();
        return;
      }
      highlightRoom(tourIndex);
      // Highlight first, then travel: the button lights up as the camera starts
      // moving toward it rather than after it arrives.
      goToRoom(h, () => {
        if (!tourActive) return;
        tourTimer = setTimeout(tourNext, TOUR_DWELL_MS);
      });
    }

    function stopTour() {
      if (!tourActive) return;
      tourActive = false;
      tourIndex = -1;
      if (tourTimer) {
        clearTimeout(tourTimer);
        tourTimer = null;
      }
      // Drop the pending arrival callback so a travel animation still in
      // flight can't schedule another leg after we've stopped.
      if (moveAnim) moveAnim.onArrive = null;
      highlightRoom(null);
      updateTourButton();
    }

    function toggleTour() {
      if (tourActive) stopTour();
      else startTour();
    }

    function exportRooms() {
      return HOTSPOTS.map((h) => ({
        x: h.position.x,
        y: h.position.y,
        z: h.position.z,
        rx: h.rx || 0,
        ry: h.ry || 0,
        rz: h.rz || 0,
        label: h.label
      }));
    }

    // null (not undefined) when unset, so the server can tell "clear this"
    // apart from "leave it alone".
    function exportStart() {
      if (!START) return null;
      return {
        x: START.position.x,
        y: START.position.y,
        z: START.position.z,
        rx: START.rx || 0,
        ry: START.ry || 0,
        rz: START.rz || 0
      };
    }

    function emitStartChanged() {
      if (config.onStartChanged) config.onStartChanged(exportStart());
    }

    /* ---------------------------------------------------------------
       INSPECTOR PANEL (editor only)
       A second, more complete authoring surface for the same HOTSPOTS
       array the rooms panel edits. Both stay in sync through
       refreshRoomUI(), so neither can show stale values.
       --------------------------------------------------------------- */
    function inspectorEl(id) {
      return document.getElementById(id);
    }

    function hasInspector() {
      return editable && !!inspectorEl("inspectorPanel");
    }

    function selectedRoom() {
      return selectedRoomIndex !== null ? HOTSPOTS[selectedRoomIndex] || null : null;
    }

    function selectRoom(i, travel) {
      selectedRoomIndex = i;
      buildInspectorPanel();
      if (travel && HOTSPOTS[i]) {
        stopTour();
        highlightRoom(i); // keep the rooms panel in step with the inspector
        goToRoom(HOTSPOTS[i]);
      }
    }

    function buildInspectorList() {
      const list = inspectorEl("inspectorViews");
      if (!list) return;
      list.innerHTML = "";

      HOTSPOTS.forEach((h, i) => {
        const row = document.createElement("div");
        row.className = "inspector-row" + (i === selectedRoomIndex ? " selected" : "");

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "inspector-icon-btn danger";
        remove.title = "Delete view";
        remove.textContent = "\u2715";
        remove.addEventListener("click", (e) => {
          e.stopPropagation();
          HOTSPOTS.splice(i, 1);
          // Keep the selection sane: stay at the same slot if one still
          // exists there, otherwise fall back to the last view.
          if (HOTSPOTS.length === 0) selectedRoomIndex = null;
          else if (selectedRoomIndex !== null && selectedRoomIndex >= HOTSPOTS.length)
            selectedRoomIndex = HOTSPOTS.length - 1;
          refreshRoomUI();
          emitRoomsChanged();
        });

        const name = document.createElement("button");
        name.type = "button";
        name.className = "inspector-row-name";
        name.textContent = h.label;
        name.title = "Select and travel here";
        name.addEventListener("click", () => selectRoom(i, true));

        const duplicate = document.createElement("button");
        duplicate.type = "button";
        duplicate.className = "inspector-icon-btn";
        duplicate.title = "Duplicate view";
        duplicate.textContent = "\u29C9";
        duplicate.addEventListener("click", (e) => {
          e.stopPropagation();
          HOTSPOTS.splice(i + 1, 0, {
            position: h.position.clone(),
            rx: h.rx || 0,
            ry: h.ry || 0,
            rz: h.rz || 0,
            label: h.label + " copy"
          });
          selectedRoomIndex = i + 1;
          refreshRoomUI();
          emitRoomsChanged();
        });

        row.appendChild(remove);
        if (i > 0) {
          const moveUp = document.createElement("button");
          moveUp.type = "button";
          moveUp.className = "inspector-icon-btn";
          moveUp.title = "Move view up";
          moveUp.textContent = "↑";
          moveUp.addEventListener("click", (e) => {
            e.stopPropagation();
            [HOTSPOTS[i - 1], HOTSPOTS[i]] = [HOTSPOTS[i], HOTSPOTS[i - 1]];
            selectedRoomIndex = i - 1;
            refreshRoomUI();
            emitRoomsChanged();
          });
          row.appendChild(moveUp);
        }
        row.appendChild(name);
        row.appendChild(duplicate);
        if (i < HOTSPOTS.length - 1) {
          const moveDown = document.createElement("button");
          moveDown.type = "button";
          moveDown.className = "inspector-icon-btn";
          moveDown.title = "Move view down";
          moveDown.textContent = "↓";
          moveDown.addEventListener("click", (e) => {
            e.stopPropagation();
            [HOTSPOTS[i], HOTSPOTS[i + 1]] = [HOTSPOTS[i + 1], HOTSPOTS[i]];
            selectedRoomIndex = i + 1;
            refreshRoomUI();
            emitRoomsChanged();
          });
          row.appendChild(moveDown);
        }
        list.appendChild(row);
      });
    }

    function buildStartPanel() {
      const details = inspectorEl("startDetails");
      const empty = inspectorEl("startEmpty");
      const clear = inspectorEl("btnStartClear");
      const go = inspectorEl("btnStartGo");

      // With no start set the visitor falls back to the first view, so spell
      // that out rather than showing six meaningless zeroes.
      if (!START) {
        if (details) details.style.display = "none";
        if (empty) {
          empty.style.display = "block";
          empty.textContent =
            HOTSPOTS.length > 0
              ? "Not set — visitors start at \u201C" + HOTSPOTS[0].label + "\u201D."
              : "Not set — visitors start at the centre of the model.";
        }
        if (clear) clear.style.display = "none";
        if (go) go.style.display = "none";
        return;
      }

      if (details) details.style.display = "block";
      if (empty) empty.style.display = "none";
      if (clear) clear.style.display = "";
      if (go) go.style.display = "";

      setInspectorNumber("startX", START.position.x, 2);
      setInspectorNumber("startY", START.position.y, 2);
      setInspectorNumber("startZ", START.position.z, 2);
      setInspectorNumber("startRotX", (START.rx || 0) * RAD_TO_DEG, 0);
      setInspectorNumber("startRotY", (START.ry || 0) * RAD_TO_DEG, 0);
      setInspectorNumber("startRotZ", (START.rz || 0) * RAD_TO_DEG, 0);
    }

    function buildInspectorPanel() {
      if (!hasInspector()) return;
      inspectorEl("inspectorPanel").classList.add("show");
      buildInspectorList();
      buildStartPanel();

      const details = inspectorEl("inspectorDetails");
      const empty = inspectorEl("inspectorEmpty");
      const h = selectedRoom();

      if (!h) {
        if (details) details.style.display = "none";
        if (empty) empty.style.display = "block";
        return;
      }
      if (details) details.style.display = "block";
      if (empty) empty.style.display = "none";

      // Writing straight to .value (rather than rebuilding these inputs)
      // is what keeps the caret in place while the user is typing.
      const name = inspectorEl("inspectorName");
      if (name && document.activeElement !== name) name.value = h.label;
      setInspectorNumber("inspectorX", h.position.x, 2);
      setInspectorNumber("inspectorY", h.position.y, 2);
      setInspectorNumber("inspectorZ", h.position.z, 2);
      setInspectorNumber("inspectorRotX", (h.rx || 0) * RAD_TO_DEG, 0);
      setInspectorNumber("inspectorRotY", (h.ry || 0) * RAD_TO_DEG, 0);
      setInspectorNumber("inspectorRotZ", (h.rz || 0) * RAD_TO_DEG, 0);
    }

    function setInspectorNumber(id, value, decimals) {
      const el = inspectorEl(id);
      if (!el || document.activeElement === el) return;
      el.value = formatNumber(value, decimals);
    }

    function wireInspector() {
      if (!hasInspector()) return;

      // Every section header collapses its own section, so adding a section to
      // the markup needs no matching JS change here.
      document.querySelectorAll(".inspector-head").forEach((head) => {
        head.addEventListener("click", () => {
          const section = head.closest(".inspector-section");
          if (!section) return;
          const collapsed = section.classList.toggle("collapsed");
          head.setAttribute("aria-expanded", String(!collapsed));
          const caret = head.querySelector(".inspector-caret");
          if (caret) caret.textContent = collapsed ? "+" : "\u2212";
        });
      });

      const name = inspectorEl("inspectorName");
      if (name) {
        name.addEventListener("input", () => {
          const h = selectedRoom();
          if (!h) return;
          h.label = name.value;
          buildInspectorList(); // keep the list label live
          emitRoomsChanged();
        });
        // Blank names would render an unclickable button in the viewer, so
        // fall back rather than persisting an empty label.
        name.addEventListener("change", () => {
          const h = selectedRoom();
          if (!h) return;
          if (!h.label.trim()) h.label = "View " + (selectedRoomIndex + 1);
          refreshRoomUI();
          emitRoomsChanged();
        });
      }

      bindInspectorNumber("inspectorX", "x");
      bindInspectorNumber("inspectorY", "y");
      bindInspectorNumber("inspectorZ", "z");
      bindInspectorNumber("inspectorRotX", "rx");
      bindInspectorNumber("inspectorRotY", "ry");
      bindInspectorNumber("inspectorRotZ", "rz");

      const setCurrent = inspectorEl("btnSetCurrent");
      if (setCurrent) {
        setCurrent.addEventListener("click", () => {
          const h = selectedRoom();
          if (!h) return;
          h.position = getPlayerFloorPosition();
          h.rx = walkCamera.rotation.x;
          h.ry = walkCamera.rotation.y;
          h.rz = walkCamera.rotation.z;
          refreshRoomUI();
          emitRoomsChanged();
        });
      }

      bindStartNumber("startX", "x");
      bindStartNumber("startY", "y");
      bindStartNumber("startZ", "z");
      bindStartNumber("startRotX", "rx");
      bindStartNumber("startRotY", "ry");
      bindStartNumber("startRotZ", "rz");

      const startSet = inspectorEl("btnStartSetCurrent");
      if (startSet) {
        startSet.addEventListener("click", () => {
          const p = getPlayerFloorPosition();
          START = {
            position: p,
            rx: walkCamera.rotation.x,
            ry: walkCamera.rotation.y,
            rz: walkCamera.rotation.z
          };
          buildStartPanel();
          emitStartChanged();
        });
      }

      const startGo = inspectorEl("btnStartGo");
      if (startGo) {
        startGo.addEventListener("click", () => {
          if (START) goToRoom(START); // animated, so it reads as "travel there"
        });
      }

      const startClear = inspectorEl("btnStartClear");
      if (startClear) {
        startClear.addEventListener("click", () => {
          START = null;
          buildStartPanel();
          emitStartChanged();
        });
      }

      const add = inspectorEl("btnAddView");
      if (add) {
        add.addEventListener("click", () => {
          HOTSPOTS.push({
            position: getPlayerFloorPosition(),
            rx: walkCamera.rotation.x,
            ry: walkCamera.rotation.y,
            rz: walkCamera.rotation.z,
            label: "View " + (HOTSPOTS.length + 1)
          });
          selectedRoomIndex = HOTSPOTS.length - 1;
          refreshRoomUI();
          emitRoomsChanged();
          const nameInput = inspectorEl("inspectorName");
          if (nameInput) {
            nameInput.focus();
            nameInput.select();
          }
        });
      }

      // Show the panel straight away rather than waiting for the model to
      // finish loading — a large GLB takes a while, and if it fails outright
      // the panel would never appear at all.
      buildInspectorPanel();
    }

    // Shared numeric-input plumbing. Half-typed values ("-", ".", "-.") are
    // ignored so the field doesn't fight the user mid-keystroke.
    function bindNumberField(id, apply) {
      const el = inspectorEl(id);
      if (!el) return;
      el.addEventListener("input", () => {
        const raw = el.value.trim();
        if (!raw || raw === "-" || raw === "." || raw === "-.") return;
        const value = Number(raw);
        if (!Number.isFinite(value)) return;
        apply(value);
      });
      // Full refresh only on commit — rebuilding the panels on every keystroke
      // would fight the user for focus.
      el.addEventListener("change", () => refreshRoomUI());
    }

    // Write a position/rotation field onto a room-shaped object.
    function applyPositionField(target, field, value) {
      if (field === "x") target.position.x = value;
      if (field === "y") target.position.y = value;
      if (field === "z") target.position.z = value;
      if (field === "rx") target.rx = value * DEG_TO_RAD;
      if (field === "ry") target.ry = value * DEG_TO_RAD;
      if (field === "rz") target.rz = value * DEG_TO_RAD;
    }

    function bindInspectorNumber(id, field) {
      bindNumberField(id, (value) => {
        const h = selectedRoom();
        if (!h) return;
        applyPositionField(h, field, value);
        // Move the camera to the value as it is typed, so the number fields
        // act as a live preview of the view being authored rather than
        // something you have to save and re-enter to check.
        previewRoom(h);
        emitRoomsChanged();
      });
    }

    function bindStartNumber(id, field) {
      bindNumberField(id, (value) => {
        if (!START) return;
        applyPositionField(START, field, value);
        previewRoom(START); // same live preview as the view fields
        emitStartChanged();
      });
    }

    function refreshRoomUI() {
      buildHotspotDOM();
      buildRoomsPanel();
      buildInspectorPanel();
    }

    function restoreEditorState(state) {
      if (!editable || !state) return;
      HOTSPOTS = (state.rooms || []).map((room) => ({
        position: new BABYLON.Vector3(room.x, room.y, room.z),
        label: room.label,
        rx: asNumber(room.rx),
        ry: asNumber(room.ry),
        rz: asNumber(room.rz)
      }));
      START = toRoomLike(state.start);
      selectedRoomIndex = HOTSPOTS.length
        ? Math.min(state.selectedRoomIndex ?? 0, HOTSPOTS.length - 1)
        : null;
      refreshRoomUI();
      emitRoomsChanged();
      emitStartChanged();
    }

    if (editable) wireInspector();

    // Outside the `editable` block on purpose: visitors get this panel too, and
    // the collapse toggle used to be wired only for the editor, leaving the
    // arrow button inert in the public viewer.
    const collapseBtn = document.getElementById("btnRoomsCollapse");
    if (collapseBtn) {
      collapseBtn.addEventListener("click", () => {
        const panel = document.getElementById("roomsPanel");
        const collapsed = panel.classList.toggle("collapsed");
        collapseBtn.textContent = collapsed ? "▼" : "▲";
      });
    }

    const tourBtn = document.getElementById("btnPlayTour");
    if (tourBtn) tourBtn.addEventListener("click", toggleTour);
    updateTourButton(); // hidden until the model loads and rooms are known

    /* ---------------------------------------------------------------
       FULLSCREEN
       The whole document goes fullscreen rather than just the canvas,
       so the top bar, rooms panel and inspector stay usable — putting
       only the canvas fullscreen would hide every control.
       --------------------------------------------------------------- */
    function fullscreenElement() {
      return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    function toggleFullscreen() {
      // Prefixed variants are still needed for older iOS/Safari. The promise
      // rejects if the gesture isn't trusted, which is not worth surfacing.
      if (fullscreenElement()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) Promise.resolve(exit.call(document)).catch(() => {});
        return;
      }
      const el = document.documentElement;
      const request = el.requestFullscreen || el.webkitRequestFullscreen;
      if (request) Promise.resolve(request.call(el)).catch(() => {});
    }

    function updateFullscreenButton() {
      const btn = document.getElementById("btnFullscreen");
      if (!btn) return;
      const on = !!fullscreenElement();
      // Same as the tour button: both icons are already in the DOM, CSS picks.
      btn.classList.toggle("active", on);
      btn.title = on ? "Exit fullscreen (Esc)" : "Fullscreen";
      btn.setAttribute("aria-label", btn.title);
    }

    const fsBtn = document.getElementById("btnFullscreen");
    if (fsBtn) {
      fsBtn.addEventListener("click", toggleFullscreen);
      // Driven by the event, not the click, so pressing Esc to leave
      // fullscreen also puts the button back to its normal state.
      document.addEventListener("fullscreenchange", updateFullscreenButton);
      document.addEventListener("webkitfullscreenchange", updateFullscreenButton);
      updateFullscreenButton();
    }

    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    loadModel(config.modelUrl);

    return {
      exportRooms,
      exportStart,
      restoreEditorState,
      goToRoom,
      spawnAtStart,
      spawnAtCenter,
      startTour,
      stopTour,
      toggleFullscreen,
      engine,
      scene
    };
  }

  return { boot };
})();
