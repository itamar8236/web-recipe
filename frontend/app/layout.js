import '@/styles/globals.css';
import Shell from '@/components/Shell';
import RegisterServiceWorker from '@/components/RegisterServiceWorker';

export const metadata = {
  title: 'My Recipes',
  description: 'A simple place to keep recipes in English and Hebrew.',
  icons: { apple: '/icons/apple-touch-icon.png' },
};

export const viewport = { themeColor: '#c4501b' };

export default function RootLayout({ children }) {
  // lang/dir are set on the client from the saved language choice.
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body>
        <RegisterServiceWorker />
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
