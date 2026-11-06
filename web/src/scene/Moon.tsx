import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { currentCelestial } from './celestial';

/** A lit sphere projected onto a disc gives a true curved phase terminator. */
export function Moon() {
  const group = useRef<THREE.Group>(null);
  const material = useRef<THREE.ShaderMaterial>(null);
  useFrame(({ camera }) => {
    const state = currentCelestial();
    const cam = camera as THREE.PerspectiveCamera;
    const height = 300 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    if (group.current) {
      group.current.position.set(state.moonScreen.x * height * cam.aspect, state.moonScreen.y * height, -300);
      group.current.scale.setScalar(state.moonScale);
      group.current.rotation.z = state.illumination.angle - state.moon.parallacticAngle;
      group.current.visible = state.moonVisibility > 0.001;
    }
    if (material.current) {
      material.current.uniforms.fraction.value = state.illumination.fraction;
      material.current.uniforms.visibility.value = state.moonVisibility;
      material.current.uniforms.night.value = state.night;
    }
  });
  return <group ref={group}>
    <mesh>
      <planeGeometry args={[7, 7]} />
      <shaderMaterial ref={material} transparent depthWrite={false} depthTest fog={false}
        uniforms={{ night: { value: 0 }, fraction: { value: 0 }, visibility: { value: 0 } }}
        vertexShader={'varying vec2 discUv; void main(){ discUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }'}
        fragmentShader={`varying vec2 discUv; uniform float fraction; uniform float visibility; uniform float night;
          void main(){
            vec2 p=discUv*2.0-1.0; float r=dot(p,p); if(r>1.0) discard;
            vec3 n=vec3(p,sqrt(1.0-r));
            float z=2.0*fraction-1.0;
            vec3 light=vec3(0.0,sqrt(max(0.0,1.0-z*z)),z);
            float lit=smoothstep(-0.025,0.025,dot(n,light));
            float textureShade=0.95+0.05*sin(p.x*31.0)*sin(p.y*24.0);
            gl_FragColor=vec4(mix(vec3(0.08,0.11,0.17),vec3(1.0,0.96,0.84)*textureShade,lit),visibility*mix(0.12*night,1.0,lit)*(1.0-smoothstep(0.96,1.0,r)));
          }`} />
    </mesh>
  </group>;
}
