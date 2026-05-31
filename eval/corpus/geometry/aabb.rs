/// Axis-aligned bounding box in 3-D space.
#[derive(Clone, Copy, Debug)]
pub struct Aabb {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

impl Aabb {
    pub fn new(min: [f64; 3], max: [f64; 3]) -> Self {
        Aabb { min, max }
    }

    /// Expand the AABB to include point p.
    pub fn expand(&mut self, p: [f64; 3]) {
        for i in 0..3 {
            if p[i] < self.min[i] { self.min[i] = p[i]; }
            if p[i] > self.max[i] { self.max[i] = p[i]; }
        }
    }

    /// Test whether two AABBs overlap (including touching edges).
    pub fn intersects(&self, other: &Aabb) -> bool {
        (0..3).all(|i| self.min[i] <= other.max[i] && other.min[i] <= self.max[i])
    }

    /// Surface area of the box (used in BVH SAH cost).
    pub fn surface_area(&self) -> f64 {
        let d = [
            self.max[0] - self.min[0],
            self.max[1] - self.min[1],
            self.max[2] - self.min[2],
        ];
        2.0 * (d[0]*d[1] + d[1]*d[2] + d[2]*d[0])
    }
}
