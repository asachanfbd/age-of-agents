import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { currentCelestial } from './celestial';

export function Sun() {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.ShaderMaterial>(null);
  useFrame(({ camera }) => {
    const state = currentCelestial();
    const cam = camera as THREE.PerspectiveCamera;
    const height = 310 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    if (mesh.current) {
      mesh.current.position.set(state.sunScreen.x * height * cam.aspect, state.sunScreen.y * height, -310);
      mesh.current.visible = state.sunVisibility > 0;
    }
    if (material.current) {
      material.current.uniforms.visibility.value = state.sunVisibility;
      material.current.uniforms.tint.value.set(state.sun.altitude < 0.2 ? '#ffb46c' : '#fff4cb');
    }
  });
  return <mesh ref={mesh}>
    <planeGeometry args={[18, 18]} />
    <shaderMaterial ref={material} transparent depthTest depthWrite={false} fog={false}
      uniforms={{ visibility: { value: 0 }, tint: { value: new THREE.Color('#fff4cb') } }}
      vertexShader={'varying vec2 discUv; void main(){discUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}'}
      fragmentShader={`varying vec2 discUv; uniform float visibility; uniform vec3 tint;
        void main(){float r=length(discUv*2.0-1.0); float disc=1.0-smoothstep(0.37,0.4,r);
          float halo=exp(-r*r*6.0)*0.24*(1.0-smoothstep(0.8,1.0,r));
          gl_FragColor=vec4(tint,max(disc,halo)*visibility);}`} />
  </mesh>;
}
