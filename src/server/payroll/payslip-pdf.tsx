import "server-only";

import path from "node:path";

import {
  Document,
  Font,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";

import { formatDate } from "@/lib/dates";
import { maskAccount, maskRsaPin } from "@/lib/mask";
import { formatNaira, type Kobo } from "@/lib/money";
import {
  lessNaira,
  periodLine,
  rentLine,
  signedNaira,
  type PayslipLineView,
  type PayslipView,
} from "@/lib/payroll/payslip-view";

/**
 * A payslip as a PDF (slice 5.5, decision 14), made once at release with @react-pdf/renderer and
 * stored in the private `payslips` bucket. It shows the company's name and logo, the period and
 * pay date, What you earned, Taken out, Your employer also paid, This year so far, the rent line
 * and the rule set's name (WkPayslip board). Money as documents show it: ₦ with commas and two
 * decimals (DESIGN_SYSTEM "Voice"). No illustration (DESIGN_SYSTEM "Illustrations").
 *
 * Personal data (rule 9): the bank account and RSA PIN appear masked from their last 4 digits
 * only; the view never holds a full number, a NIN, a BVN or a TIN.
 *
 * Fonts: Inter (SIL Open Font License, fonts/LICENSE.txt), embedded so ₦ renders. Next traces
 * the files for /app/payroll routes (next.config.ts outputFileTracingIncludes).
 */

const FONT_DIR = path.join(process.cwd(), "src", "server", "payroll", "fonts");

let fontsReady = false;
function registerFonts(): void {
  if (fontsReady) return;
  Font.register({
    family: "Inter",
    fonts: [
      { src: path.join(FONT_DIR, "Inter-Regular.ttf"), fontWeight: 400 },
      { src: path.join(FONT_DIR, "Inter-SemiBold.ttf"), fontWeight: 600 },
      { src: path.join(FONT_DIR, "Inter-Bold.ttf"), fontWeight: 700 },
    ],
  });
  // Never split words across lines: names and amounts stay whole.
  Font.registerHyphenationCallback((word) => [word]);
  fontsReady = true;
}

const FG = "#0A0A0A";
const MUTED = "#52525B";
const LINE = "#E4E4E7";
const SURFACE = "#F4F4F5";

const s = StyleSheet.create({
  page: {
    fontFamily: "Inter",
    fontSize: 10,
    color: FG,
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 40,
    lineHeight: 1.4,
  },
  header: { flexDirection: "row", justifyContent: "space-between", gap: 16 },
  brand: { flexDirection: "row", gap: 10, alignItems: "center", maxWidth: 300 },
  logo: { width: 44, height: 44, objectFit: "contain" },
  company: { fontSize: 14, fontWeight: 700 },
  muted: { color: MUTED },
  small: { fontSize: 8.5, color: MUTED },
  titleBlock: { alignItems: "flex-end" },
  title: { fontSize: 18, fontWeight: 700 },
  rule: { borderBottomWidth: 1, borderBottomColor: LINE, marginVertical: 14 },
  people: { flexDirection: "row", justifyContent: "space-between", gap: 16 },
  label: {
    fontSize: 8,
    fontWeight: 600,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: MUTED,
    marginBottom: 4,
  },
  net: {
    marginTop: 14,
    padding: 14,
    borderRadius: 8,
    backgroundColor: FG,
    color: "#FFFFFF",
  },
  netLabel: { fontSize: 8, fontWeight: 600, letterSpacing: 0.6, color: "#A1A1AA" },
  netValue: { fontSize: 24, fontWeight: 700, marginTop: 2 },
  netNote: { fontSize: 9, color: "#D4D4D8", marginTop: 2 },
  columns: { flexDirection: "row", gap: 24, marginTop: 16 },
  column: { flex: 1 },
  section: { marginTop: 14 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
  },
  rowLast: { borderBottomWidth: 0, fontWeight: 600 },
  amount: { textAlign: "right" },
  box: { marginTop: 14, padding: 10, borderRadius: 8, backgroundColor: SURFACE },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 40,
    right: 40,
    fontSize: 8,
    color: MUTED,
    flexDirection: "row",
    justifyContent: "space-between",
  },
});

const money = (k: Kobo) => formatNaira(k);

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={last ? [s.row, s.rowLast] : s.row}>
      <Text>{label}</Text>
      <Text style={s.amount}>{value}</Text>
    </View>
  );
}

function Lines({
  lines,
  sign,
}: {
  lines: readonly PayslipLineView[];
  sign: "earning" | "less" | "plain";
}) {
  return (
    <>
      {lines.map((l, i) => (
        <Row
          key={`${l.code}-${i}`}
          label={l.label}
          value={
            sign === "less"
              ? lessNaira(l.amountKobo, money)
              : sign === "earning"
                ? signedNaira(l.amountKobo, money)
                : money(l.amountKobo)
          }
        />
      ))}
    </>
  );
}

export interface PayslipPdfOptions {
  /** The company's logo as PNG bytes (an SVG logo is left out: the name stands alone). */
  logoPng?: Uint8Array | null;
  /** When the PDF is made, for the footer. */
  madeOn: string;
}

export function PayslipDocument({
  view,
  options,
}: {
  view: PayslipView;
  options: PayslipPdfOptions;
}) {
  const bank = maskAccount(view.worker.bankLast4);
  const pin = maskRsaPin(view.worker.rsaPinLast4);
  const rent = rentLine(view, money);
  const ytd = view.yearToDate;
  return (
    <Document
      title={`Payslip ${view.month}`}
      author={view.organisation.name}
      creator="Metalira Ops"
      producer="Metalira Ops"
    >
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <View style={s.brand}>
            {options.logoPng ? (
              // eslint-disable-next-line jsx-a11y/alt-text -- a PDF image, not an <img>
              <Image style={s.logo} src={{ data: Buffer.from(options.logoPng), format: "png" }} />
            ) : null}
            <View>
              <Text style={s.company}>{view.organisation.name}</Text>
              {view.organisation.legalName &&
              view.organisation.legalName !== view.organisation.name ? (
                <Text style={s.small}>{view.organisation.legalName}</Text>
              ) : null}
              {view.organisation.address ? (
                <Text style={s.small}>{view.organisation.address}</Text>
              ) : null}
            </View>
          </View>
          <View style={s.titleBlock}>
            <Text style={s.title}>Payslip</Text>
            <Text>{view.month}</Text>
            <Text style={s.small}>{periodLine(view)}</Text>
          </View>
        </View>

        <View style={s.rule} />

        <View style={s.people}>
          <View>
            <Text style={s.label}>Employee</Text>
            <Text style={{ fontWeight: 600 }}>{view.worker.name}</Text>
            <Text style={s.muted}>
              Staff ID {view.worker.staffId}
              {view.worker.jobTitle ? ` · ${view.worker.jobTitle}` : ""}
            </Text>
            {view.taxState ? <Text style={s.muted}>Tax state {view.taxState}</Text> : null}
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={s.label}>Paid to</Text>
            <Text>
              {view.worker.bankName && bank
                ? `${view.worker.bankName} ${bank}`
                : "Bank details not on file"}
            </Text>
            <Text style={s.muted}>Pay date {formatDate(view.payDate)}</Text>
          </View>
        </View>

        <View style={s.net}>
          <Text style={s.netLabel}>YOU RECEIVED · {view.month.toUpperCase()}</Text>
          <Text style={s.netValue}>{money(view.netKobo)}</Text>
          <Text style={s.netNote}>
            Gross pay {money(view.grossKobo)} less {money(view.totalTakenOutKobo)} taken out
          </Text>
        </View>

        <View style={s.columns}>
          <View style={s.column}>
            <Text style={s.label}>What you earned</Text>
            <Lines lines={view.earned} sign="earning" />
            <Row label="Gross pay" value={money(view.grossKobo)} last />
          </View>
          <View style={s.column}>
            <Text style={s.label}>Taken out</Text>
            <Lines lines={view.takenOut} sign="less" />
            <Row label="Total taken out" value={lessNaira(view.totalTakenOutKobo, money)} last />
          </View>
        </View>

        {view.carriedForwardKobo > 0n ? (
          <Text style={[s.small, { marginTop: 8 }]}>
            {money(view.carriedForwardKobo)} of deductions didn&apos;t fit this month and is still
            owed. HR takes it from a later pay.
          </Text>
        ) : null}

        <View style={s.columns}>
          <View style={s.column}>
            <View style={s.box}>
              <Text style={s.label}>Your employer also paid</Text>
              <Lines lines={view.employer} sign="plain" />
              {view.pfaName ? (
                <Text style={[s.small, { marginTop: 6 }]}>
                  Your pension goes to {view.pfaName}
                  {pin ? ` · RSA ${pin}` : ""}.
                </Text>
              ) : null}
            </View>
          </View>
          <View style={s.column}>
            <View style={s.section}>
              <Text style={s.label}>This year so far ({ytd.year})</Text>
              <Row label="Gross pay" value={money(ytd.grossKobo)} />
              <Row label="Income tax" value={money(ytd.payeKobo)} />
              <Row label="Your pension" value={money(ytd.pensionEmployeeKobo)} />
              {ytd.nhfKobo > 0n ? (
                <Row label="Housing fund (NHF)" value={money(ytd.nhfKobo)} />
              ) : null}
              <Row label="Net pay" value={money(ytd.netKobo)} last />
            </View>
          </View>
        </View>

        {rent ? <Text style={[s.muted, { marginTop: 14 }]}>{rent}</Text> : null}
        {view.ruleSetName ? (
          <Text style={[s.small, { marginTop: 6 }]}>
            Worked out with the payroll rules {view.ruleSetName}.
          </Text>
        ) : null}

        <View style={s.footer} fixed>
          <Text>
            {view.organisation.name} · made with Metalira Ops on {formatDate(options.madeOn)}
          </Text>
          <Text>Keep this payslip. Questions go to HR.</Text>
        </View>
      </Page>
    </Document>
  );
}

/** Renders one payslip's PDF. The bytes are never logged. */
export async function renderPayslipPdf(
  view: PayslipView,
  options: PayslipPdfOptions,
): Promise<Uint8Array> {
  registerFonts();
  const buffer = await renderToBuffer(<PayslipDocument view={view} options={options} />);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
