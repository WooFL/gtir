/// Hamilton product of two quaternions (w, x, y, z).
pub fn mul(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    [
        a[0]*b[0] - a[1]*b[1] - a[2]*b[2] - a[3]*b[3],
        a[0]*b[1] + a[1]*b[0] + a[2]*b[3] - a[3]*b[2],
        a[0]*b[2] - a[1]*b[3] + a[2]*b[0] + a[3]*b[1],
        a[0]*b[3] + a[1]*b[2] - a[2]*b[1] + a[3]*b[0],
    ]
}

/// Normalize a quaternion to unit length.
pub fn normalize(q: [f64; 4]) -> [f64; 4] {
    let len = (q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]).sqrt();
    if len < 1e-12 { return [1.0, 0.0, 0.0, 0.0]; }
    [q[0]/len, q[1]/len, q[2]/len, q[3]/len]
}

/// Rotate a 3-D vector by a unit quaternion using the sandwich product q*v*q^-1.
pub fn rotate_vec(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let qv = [0.0, v[0], v[1], v[2]];
    let q_conj = [q[0], -q[1], -q[2], -q[3]];
    let r = mul(mul(q, qv), q_conj);
    [r[1], r[2], r[3]]
}
