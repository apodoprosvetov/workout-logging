import { Header } from '@components/header';

export default function AuthLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
