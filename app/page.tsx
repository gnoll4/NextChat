import { Analytics } from "@vercel/analytics/react";
import { Home } from "./components/home";
import { D1ChatSync } from "./components/d1-chat-sync";
import { getServerSideConfig } from "./config/server";

const serverConfig = getServerSideConfig();

export default async function App() {
  return (
    <>
      <D1ChatSync />
      <Home />
      {serverConfig?.isVercel && (
        <>
          <Analytics />
        </>
      )}
    </>
  );
}
