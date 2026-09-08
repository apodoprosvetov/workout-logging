import { Header } from '@components/header';
import { Sidebar } from '@components/sidebar';

export default function MainLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <div className="flex flex-1">
        <Sidebar />
        <main className="flex flex-1 flex-col">{children}</main>
      </div>
    </div>
  );
}
