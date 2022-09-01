export class Vec {
  static dot(v1, v2) {
    let res = 0;
    for (let i = 0; i < v1.length; i++) {
      res += v1[i] * v2[i];
    }
    return res;
  }

  static magnitude(v) {
    return Math.sqrt(v.map(e => e * e).reduce((a, b) => { return a + b }));
  }

  static normalize(v) {
    let m = this.magnitude(v);
    return this.scale(v, 1 / m);
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

  static eq(e1, e2) {
    if (e1.length !== e2.length) {
      return false;
    }
    for (let i = 0; i < e1.length; i++) {
      if (Math.abs(e1[i] - e2[i]) > 0.001) {
        return false;
      }
    }
    return true;
  }

  static copy(v) {
    return [...v];
  }

  static matMultiply(m1, m2) {
    const res = new Array(4);
    const col = new Array(4);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        col[j] = m2[4 * i + j];
      }
      res[i] = this.matVecMultiply(m1, col);
    }
    return [...res[0], ...res[1], ...res[2], ...res[3]];
  }

  static matVecMultiply(mat, v) {
    const padded = [0, 0, 0, 1];
    padded.splice(0, v.length, ...v);
    let col = new Array(4)
    let res = new Array(4);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        col[j] = mat[4 * j + i];
      }
      res[i] = this.dot(col, padded);
    }
    return res.slice(0, v.length);
  }

  // Adapted from https://github.com/mrdoob/three.js/blob/master/src/math/Matrix4.js
  static composeTRSMatrix(translation, quaternion, scale) {
    const m = new Array(16);
    const x = quaternion[0], y = quaternion[1], z = quaternion[2], w = quaternion[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = scale[0], sy = scale[1], sz = scale[2];
    m[0] = (1 - (yy + zz)) * sx;
    m[1] = (xy + wz) * sx;
    m[2] = (xz - wy) * sx;
    m[3] = 0;
    m[4] = (xy - wz) * sy;
    m[5] = (1 - (xx + zz)) * sy;
    m[6] = (yz + wx) * sy;
    m[7] = 0;
    m[8] = (xz + wy) * sz;
    m[9] = (yz - wx) * sz;
    m[10] = (1 - (xx + yy)) * sz;
    m[11] = 0;
    m[12] = translation[0];
    m[13] = translation[1];
    m[14] = translation[2];
    m[15] = 1;
    return m;
  }

  // Adapted from https://github.com/mrdoob/three.js/blob/master/src/math/Matrix4.js
  static transposeMatrix(mm) {
    let m = new Array(...mm);
    let tmp;
    tmp = m[1]; m[1] = m[4]; m[4] = tmp;
    tmp = m[2]; m[2] = m[8]; m[8] = tmp;
    tmp = m[6]; m[6] = m[9]; m[9] = tmp;
    tmp = m[3]; m[3] = m[12]; m[12] = tmp;
    tmp = m[7]; m[7] = m[13]; m[13] = tmp;
    tmp = m[11]; m[11] = m[14]; m[14] = tmp;
    return m;
  }

  // Adapted from https://github.com/mrdoob/three.js/blob/master/src/math/Matrix4.js
  static invertMatrix(mm) {
    let m = new Array(...mm);
    // based on http://www.euclideanspace.com/maths/algebra/matrix/functions/inverse/fourD/index.htm
    const n11 = m[0], n21 = m[1], n31 = m[2], n41 = m[3],
      n12 = m[4], n22 = m[5], n32 = m[6], n42 = m[7],
      n13 = m[8], n23 = m[9], n33 = m[10], n43 = m[11],
      n14 = m[12], n24 = m[13], n34 = m[14], n44 = m[15],
      t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44,
      t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44,
      t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44,
      t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
    const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
    if (det === 0) return m.fill(0);
    const detInv = 1 / det;
    m[0] = t11 * detInv;
    m[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * detInv;
    m[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * detInv;
    m[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * detInv;
    m[4] = t12 * detInv;
    m[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * detInv;
    m[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * detInv;
    m[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * detInv;
    m[8] = t13 * detInv;
    m[9] = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * detInv;
    m[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * detInv;
    m[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * detInv;
    m[12] = t14 * detInv;
    m[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * detInv;
    m[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * detInv;
    m[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * detInv;
    return m;
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
    let mat = [oc * x * x + c, oc * x * y - z * s, oc * z * x + y * s, 0,
    oc * x * y + z * s, oc * y * y + c, oc * y * z - x * s, 0,
    oc * z * x - y * s, oc * y * z + x * s, oc * z * z + c, 0,
      0, 0, 0, 1
    ];
    return Vec3.matVecMultiply(mat, v);
  }

  static cross(v1, v2) {
    let x = v1[1] * v2[2] - v1[2] * v2[1],
      y = -(v1[0] * v2[2] - v1[2] * v2[0]),
      z = v1[0] * v2[1] - v1[1] * v2[0];
    return [x, y, z];
  }
}

function test() {
  {
    const v = [0, 1, 0];
    const m = Vec.composeTRSMatrix([1, 1, 1], [0, 0, 0, 1], [3, 3, 3]);
    const res = Vec.matVecMultiply(m, v);
    const want = [1, 4, 1];
    if (!Vec.eq(res, want)) {
      console.log("Failed. Want:", want, "got:", res);
    } else {
      console.log("Passed. Want:", want, "got:", res);
    }
  }
  {
    const v = [0, 0.707, -0.707];
    const m = Vec.composeTRSMatrix([0, 0, 0], [0.3826834, 0, 0, 0.9238795], [1, 1, 1]);
    const res = Vec.matVecMultiply(m, v);
    const want = [0, 1, 0];
    if (!Vec.eq(res, want)) {
      console.log("Failed. Want:", want, "got:", res);
    } else {
      console.log("Passed. Want:", want, "got:", res);
    }
  }
  {
    const res = Vec.composeTRSMatrix([0, 0, 0], [0.3826834, 0, 0, 0.9238795], [1, 1, 1]);
    const want = Vec.transposeMatrix(Vec.invertMatrix(res));
    if (!Vec.eq(res, want)) {
      console.log("Failed. Want:", want, "got:", res);
    } else {
      console.log("Passed. Want:", want, "got:", res);
    }
  }
  {
    const res = Vec.composeTRSMatrix([1, 1, 1], [0.3826834, 0, 0, 0.9238795], [3, 3, 3]);
    const want = Vec.invertMatrix(Vec.invertMatrix(res));
    if (!Vec.eq(res, want)) {
      console.log("Failed. Want:", want, "got:", res);
    } else {
      console.log("Passed. Want:", want, "got:", res);
    }
  }
  {
    const res = Vec.composeTRSMatrix([1, 1, 1], [0.3826834, 0, 0, 0.9238795], [3, 3, 3]);
    const want = Vec.invertMatrix(Vec.invertMatrix(res));
    if (!Vec.eq(res, want)) {
      console.log("Failed. Want:", want, "got:", res);
    } else {
      console.log("Passed. Want:", want, "got:", res);
    }
  }
  {
    const translation = Vec.composeTRSMatrix([1, 1, 1], [0, 0, 0, 1], [1, 1, 1]);
    const scale = Vec.composeTRSMatrix([0, 0, 0], [0, 0, 0, 1], [3, 3, 3]);
    const res = Vec.matMultiply(translation, scale);
    const want = Vec.composeTRSMatrix([1, 1, 1], [0, 0, 0, 1], [3, 3, 3]);
    if (!Vec.eq(res, want)) {
      console.log("Failed. Want:", want, "got:", res);
    } else {
      console.log("Passed. Want:", want, "got:", res);
    }
  }
  {
    const translation = Vec.composeTRSMatrix([1, 1, 1], [0, 0, 0, 1], [1, 1, 1]);
    const rotation = Vec.composeTRSMatrix([0,0,0], [0.3826834, 0, 0, 0.9238795], [1, 1, 1]);
    const res = Vec.matMultiply(translation, rotation);
    const want = Vec.composeTRSMatrix([1, 1, 1], [0.3826834, 0, 0, 0.9238795], [1, 1, 1]);
    if (!Vec.eq(res, want)) {
      console.log("Failed. Want:", want, "got:", res);
    } else {
      console.log("Passed. Want:", want, "got:", res);
    }
  }
  {
    const translation = Vec.composeTRSMatrix([1, 1, 1], [0, 0, 0, 1], [1, 1, 1]);
    const rotation = Vec.composeTRSMatrix([0,0,0], [0.3826834, 0, 0, 0.9238795], [1, 1, 1]);
    const scale = Vec.composeTRSMatrix([0, 0, 0], [0, 0, 0, 1], [3, 3, 3]);
    const res = Vec.matMultiply(translation, Vec.matMultiply(rotation, scale));
    const want = Vec.composeTRSMatrix([1, 1, 1], [0.3826834, 0, 0, 0.9238795], [3, 3, 3]);
    if (!Vec.eq(res, want)) {
      console.log("Failed. Want:", want, "got:", res);
    } else {
      console.log("Passed. Want:", want, "got:", res);
    }
  }
  console.log("Done.")
}
// test();