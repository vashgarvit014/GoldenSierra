import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="text-sm text-muted">That page does not exist.</p>
      <Link href="/" className="text-sm text-sierra-700 underline dark:text-sierra-300">
        Back to the Workforce Navigator
      </Link>
    </main>
  );
}
