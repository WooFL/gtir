// Separable Gaussian blur, compute shader. Run it once horizontally and once vertically — two cheap 1D
// passes instead of one expensive 2D kernel. Each thread reads a row of taps, weights them by the
// Gaussian falloff, and writes one blurred texel back to the output image.
Texture2D<float4>   src : register(t0);
RWTexture2D<float4> dst : register(u0);

static const float weights[5] = { 0.227027, 0.194594, 0.121622, 0.054054, 0.016216 };

[numthreads(8, 8, 1)]
void BlurHorizontal(uint3 id : SV_DispatchThreadID) {
  float4 sum = src[id.xy] * weights[0];
  for (int i = 1; i < 5; ++i) {
    sum += src[id.xy + uint2(i, 0)] * weights[i];
    sum += src[id.xy - uint2(i, 0)] * weights[i];
  }
  dst[id.xy] = sum;
}
