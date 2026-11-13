import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['@prisma/client', 'bullmq', 'ioredis', 'unpdf'],

  /**
   * Keep the local-embedding stack out of serverless bundles.
   *
   * @huggingface/transformers (279MB) + onnxruntime-node (288MB) + the cached
   * model (266MB) are far past Vercel's 250MB function limit, so a deployment
   * that traces them simply fails. They are only reachable when
   * EMBEDDING_PROVIDER=local, which is a container/VM deployment mode —
   * see docs/DEPLOYMENT.md. On a serverless host use a hosted embedding
   * provider instead.
   */
  outputFileTracingExcludes: {
    '**': [
      'node_modules/@huggingface/transformers/**',
      'node_modules/onnxruntime-node/**',
      'node_modules/onnxruntime-web/**',
      'node_modules/sharp/**',
    ],
  },
  experimental: { optimizePackageImports: ['lucide-react'] },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
