import { PiWorkbench } from "./workbench";

export const dynamic = "force-dynamic";

export default function Page() {
  return <PiWorkbench testMode={process.env.PI_TEST_MODE === "true"} />;
}
