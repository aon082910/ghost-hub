import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6 rounded-2xl border border-zinc-800 bg-zinc-950 p-8">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-zinc-50">Ghost-Hub</h1>
          <p className="text-sm text-zinc-400">Sign in to manage your digital footprint.</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
