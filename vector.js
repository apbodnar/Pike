export class Vec {
  static dot(v1, v2) {
    let res = 0;
    for (let i=0; i< v1.length; i++) {
      res += v1[i] * v2[i];
    }
    return res;
  }

  static magnitude(v) {
    return Math.sqrt(v.map(e => e*e).reduce((a,b) => {return a + b}));
  }

  static normalize(v) {
    let m = this.magnitude(v);
    return Vec3.scale(v, 1 / m);
  }

  static scale(v, s) {
    return v.map(e => e * s)
  }

  static sub(v1, v2) {
    return v1.map((e1, i) => e1 - v2[i]);
  }

  static add(v1, v2) {
    return v1.map((e1, i) => e1 + v2[i]);
  }

  static mult(v1, v2) {
    return v1.map((e1, i) => e1 * v2[i]);
  }
}

export class Vec3 extends Vec {
  static splat(s) {
    return [s, s, s]
  }

  static multAdd(v1, v2, v3) {
    return Vec3.add(Vec3.mult(v1, v2), v3);
  }

  static sqrt(v) {
    return [Math.sqrt(v[0]), Math.sqrt(v[1]), Math.sqrt(v[1])]
  }

  static inverse(v) {
    return [1.0 / v[0], 1.0 / v[1], 1.0 / v[2]];
  }

  static lerp1(v1, v2, r) {
    return Vec3.add(v1, this.scale(Vec3.sub(v2, v1), r));
  }

  static lerp3(v1, v2, r) {
    return Vec3.add(v1, this.mult(Vec3.sub(v2, v1), r));
  }

  static trunc(v) {
    return [Math.trunc(v[0]), Math.trunc(v[1]), Math.trunc(v[2])]
  }

  static pow(v, exp) {
    return [Math.pow(v[0], exp), Math.pow(v[1], exp), Math.pow(v[2], exp)]
  }

  static max(v1, v2) {
    return [Math.max(v1[0], v2[0]), Math.max(v1[1], v2[1]), Math.max(v1[2], v2[2])]
  }

  static min(v1, v2) {
    return [Math.min(v1[0], v2[0]), Math.min(v1[1], v2[1]), Math.min(v1[2], v2[2])]
  }

  static gte(v1, v2) {
    return [v1[0] >= v2[0], v1[1] >= v2[1], v1[2] >= v2[2]]
  }

  static any(v) {
    return v[0] || v[1] || v[2];
  }

  static rotateX(v, a) {
    let x = v[0],
      y = v[1],
      z = v[2],
      y1 = z * Math.sin(a) + y * Math.cos(a),
      z1 = z * Math.cos(a) - y * Math.sin(a);
    return [x, y1, z1];
  }

  static rotateY(v, a) {
    let x = v[0],
      y = v[1],
      z = v[2],
      x1 = z * Math.sin(a) + x * Math.cos(a),
      z1 = z * Math.cos(a) - x * Math.sin(a);
    return [x1, y, z1];
  }

  static rotateZ(v, a) {
    let x = v[0],
      y = v[1],
      z = v[2],
      x1 = y * Math.sin(a) + x * Math.cos(a),
      y1 = y * Math.cos(a) - x * Math.sin(a);
    return [x1, y1, z];
  }

  static clamp(num, min, max) {
    return this.min(this.max(num, min), max);
  }

  static clamp1(num, min, max) {
    return Math.min(Math.max(num, min), max);
  }

  static rotateArbitrary(v, axis, angle) {
    let x = axis[0],
      y = axis[1],
      z = axis[2];
    let s = Math.sin(angle);
    let c = Math.cos(angle);
    let oc = 1.0 - c;
    let mat = [oc * x * x + c, oc * x * y - z * s, oc * z * x + y * s,
    oc * x * y + z * s, oc * y * y + c, oc * y * z - x * s,
    oc * z * x - y * s, oc * y * z + x * s, oc * z * z + c
    ];
    return Vec3.matVecMultiply(v, mat);
  }

  static matVecMultiply(vec, mat) {
    let res = [];
    for (let i = 0; i < 3; i++) {
      let row = [mat[3 * i], mat[3 * i + 1], mat[3 * i + 2]];
      res.push(this.dot(row, vec));
    }
    return res;
  }

  static cross(v1, v2) {
    let x = v1[1] * v2[2] - v1[2] * v2[1],
      y = -(v1[0] * v2[2] - v1[2] * v2[0]),
      z = v1[0] * v2[1] - v1[1] * v2[0];
    return [x, y, z];
  }

  static rotatePointByQuaternion(p, q) {
    r = [0, ...p];
    qc = [q[0], -1 * q[1], -1 * q[2], -1 * q[3]];
    return multQuaternions(multQuaternions(q,r),q_conj).slice(1);
  }

  static multQuaternions(q, r) {
    return [r[0] * q[0] - r[1] * q[1] - r[2] * q[2] - r[3] * q[3],
    r[0] * q[1] + r[1] * q[0] - r[2] * q[3] + r[3] * q[2],
    r[0] * q[2] + r[1] * q[3] + r[2] * q[0] - r[3] * q[1],
    r[0] * q[3] - r[1] * q[2] + r[2] * q[1] + r[3] * q[0]];
  }
}