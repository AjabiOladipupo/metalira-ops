import { importTemplateCsv } from "@/server/people/imports/downloads";
import { csvResponse, importRouteAccess } from "@/server/people/imports/route-access";

/** "Download template (.csv)": the 32 template columns, ready to fill. */
export async function GET() {
  const access = await importRouteAccess();
  if (!access.ok) return access.response;
  return csvResponse(importTemplateCsv(), "employee_import_template.csv");
}
