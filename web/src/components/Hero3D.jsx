/**
 * 3D hero — an abstract village-to-clinic-to-doctor network.
 *
 * DELIBERATELY RESTRAINED. Slow ambient drift, no spin, no bloom, no
 * camera swoops. Restraint reads as expensive; spectacle reads as a
 * student project, and this is being shown to a government audience.
 *
 * PERFORMANCE IS A HARD CONSTRAINT, not an afterthought:
 *   - The whole module is lazy-loaded (see Landing.jsx), so three.js never
 *     enters the critical path.
 *   - `dpr` is capped at 1.5 — a cheap tablet's 3× device pixel ratio would
 *     otherwise render 9× the pixels for no visible benefit.
 *   - `frameloop="demand"` is NOT used because we do animate, but the
 *     scene is deliberately tiny: ~40 nodes, no shadows, no post-processing.
 *   - Reduced motion or a failed WebGL context falls back to a static
 *     gradient. A landing page that stutters on the venue projector is
 *     worse than one with no 3D at all.
 */
import { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useReducedMotion } from 'framer-motion';
import * as THREE from 'three';

/** Village nodes orbiting a central clinic, connected by soft lines. */
function Network() {
  const group = useRef();

  const { nodes, lines } = useMemo(() => {
    const n = [];
    const rings = [
      { count: 7, radius: 2.4, y: -0.3 },
      { count: 10, radius: 3.9, y: 0.35 },
      { count: 6, radius: 5.2, y: -0.8 },
    ];
    rings.forEach((ring, ri) => {
      for (let i = 0; i < ring.count; i += 1) {
        const a = (i / ring.count) * Math.PI * 2 + ri * 0.6;
        n.push({
          pos: [
            Math.cos(a) * ring.radius,
            ring.y + Math.sin(a * 2 + ri) * 0.4,
            Math.sin(a) * ring.radius,
          ],
          ring: ri,
        });
      }
    });

    // Connect each node back to the centre — the clinic is the hub, which
    // is the whole point of the picture.
    const segs = [];
    n.forEach((node) => {
      segs.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(...node.pos));
    });

    return { nodes: n, lines: new THREE.BufferGeometry().setFromPoints(segs) };
  }, []);

  useFrame((state, delta) => {
    if (!group.current) return;
    // Slow enough to read as "alive", not as "spinning".
    group.current.rotation.y += delta * 0.055;
    group.current.position.y = Math.sin(state.clock.elapsedTime * 0.35) * 0.12;
  });

  return (
    <group ref={group}>
      <lineSegments geometry={lines}>
        <lineBasicMaterial color="#22d3ee" transparent opacity={0.16} />
      </lineSegments>

      {/* The clinic at the centre. */}
      <mesh>
        <icosahedronGeometry args={[0.62, 1]} />
        <meshStandardMaterial
          color="#22d3ee" emissive="#0891b2" emissiveIntensity={0.7}
          roughness={0.3} metalness={0.4}
        />
      </mesh>

      {nodes.map((node, i) => (
        <mesh key={i} position={node.pos}>
          <sphereGeometry args={[node.ring === 0 ? 0.15 : 0.1, 12, 12]} />
          <meshStandardMaterial
            color={node.ring === 0 ? '#34d399' : '#7e94b5'}
            emissive={node.ring === 0 ? '#34d399' : '#1b2942'}
            emissiveIntensity={node.ring === 0 ? 0.45 : 0.2}
            roughness={0.55}
          />
        </mesh>
      ))}
    </group>
  );
}

/** Static fallback: reduced motion, no WebGL, or a slow device. */
function Fallback() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute', inset: 0,
        background:
          'radial-gradient(60% 60% at 50% 45%, rgba(34,211,238,.22), transparent 70%),' +
          'radial-gradient(40% 40% at 70% 70%, rgba(52,211,153,.14), transparent 70%)',
      }}
    />
  );
}

export default function Hero3D() {
  const reduce = useReducedMotion();
  if (reduce) return <Fallback />;

  return (
    <Canvas
      // 3× DPR on a cheap tablet means 9× the pixels for no visible gain.
      dpr={[1, 1.5]}
      camera={{ position: [0, 1.6, 9], fov: 46 }}
      gl={{ antialias: true, powerPreference: 'low-power' }}
      style={{ position: 'absolute', inset: 0 }}
      // If WebGL is unavailable the canvas simply never mounts; the
      // gradient behind it remains visible.
      fallback={<Fallback />}
    >
      <ambientLight intensity={0.55} />
      <pointLight position={[6, 6, 6]} intensity={90} color="#22d3ee" />
      <pointLight position={[-6, -3, -4]} intensity={45} color="#34d399" />
      <Network />
    </Canvas>
  );
}
