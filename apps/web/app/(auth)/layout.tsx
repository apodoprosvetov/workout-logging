import { Header } from '@components/header';

export default function AuthLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <Header />
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</main>
    </div>
  );
}
