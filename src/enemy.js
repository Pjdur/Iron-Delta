import * as THREE from 'three';
import { heightAt } from './terrain.js';

export class EnemyTank {
  constructor(scene, effects, playerTank, position) {
    this.scene = scene;
    this.effects = effects;
    this.playerTank = playerTank;
    
    this.pos = position.clone();
    this.quat = new THREE.Quaternion();
    this.health = 100;
    this.dead = false;

    // Hitbox components mapping (War Thunder style: module-based damage)
    this.components = {
      turret: { radius: 1.5, health: 40, points: 500 },
      hull: { radius: 2.0, health: 60, points: 200 },
      ammoRack: { radius: 0.8, health: 20, points: 1000, critical: true }
    };

    this._buildModel();
  }

  _buildModel() {
    this.root = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x3b4230, roughness: 0.8 });
    
    // Simple enemy hull & turret mesh
    const hullGeo = new THREE.BoxGeometry(2.8, 0.8, 5.2);
    this.hullMesh = new THREE.Mesh(hullGeo, mat);
    this.hullMesh.castShadow = true;
    this.root.add(this.hullMesh);

    const turretGeo = new THREE.BoxGeometry(1.8, 0.6, 2.2);
    this.turretMesh = new THREE.Mesh(turretGeo, mat);
    this.turretMesh.position.set(0, 0.6, 0.2);
    this.root.add(this.turretMesh);

    this.scene.add(this.root);
    this.root.position.copy(this.pos);
  }

  update(dt) {
    if (this.dead) return;

    // Simple AI: Face and slowly drive towards the player if within range
    const dx = this.playerTank.pos.x - this.pos.x;
    const dz = this.playerTank.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);

    if (dist < 400 && dist > 15) {
      const targetYaw = Math.atan2(dx, dz);
      this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), targetYaw);
      this.root.quaternion.slerp(this.quat, dt * 3);

      const speed = 4.0 * dt;
      this.pos.x += Math.sin(targetYaw) * speed;
      this.pos.z += Math.cos(targetYaw) * speed;
    }

    this.pos.y = heightAt(this.pos.x, this.pos.z) + 0.9;
    this.root.position.copy(this.pos);
  }

  // War Thunder style hit calculation based on component hit location
  checkHit(rayStart, rayEnd) {
    if (this.dead) { return { hit: false }; }

    const tankPos = this.pos;
    const distToCenter = rayStart.distanceTo(tankPos);

    if (distToCenter > 6) return { hit: false }; // Quick broadphase check

    // Check specific components relative to hit position
    // (Simulating a ray-sphere or ray-box check against critical modules)
    const hitPoint = rayEnd; // approximated impact point
    const localHitY = hitPoint.y - tankPos.y;

    let hitModule = 'hull';
    let pointsAwarded = 200;
    let isCritical = false;

    if (localHitY > 0.8) {
      hitModule = 'turret';
      pointsAwarded = 500;
    }
    
    // Check if hit landed near the rear/middle ammo rack zone
    const relZ = hitPoint.z - tankPos.z;
    if (relZ > 0.5 && localHitY < 0.2) {
      hitModule = 'ammo_rack';
      pointsAwarded = 1200;
      isCritical = true;
    }

    this.health -= isCritical ? 100 : 45;
    if (this.health <= 0) {
      this.dead = true;
      this.scene.remove(this.root);
      this.effects.explosion(this.pos, 1.4);
      points += 1000; // Destruction bonus
    } else {
      this.effects.explosion(hitPoint, 0.4); // Non-fatal hit spark/fire
    }

    return {
      hit: true,
      module: hitModule,
      points: pointsAwarded,
      critical: isCritical || this.dead
    };
  }
}