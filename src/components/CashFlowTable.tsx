import { CashFlowRow } from "@/lib/cashFlowSchedule";

interface CashFlowTableProps {
  rows: CashFlowRow[] | null;
  custodyCurrency: string;
}

const HEAD_ROWS = 5;
const TAIL_ROWS = 5;
const MAX_VISIBLE_ROWS = HEAD_ROWS + TAIL_ROWS;

function formatAmount(n: number, isKrw: boolean): string {
  if (isKrw) {
    return Math.trunc(n).toLocaleString("ko-KR");
  }
  const truncated = Math.trunc(n * 100) / 100;
  return truncated.toLocaleString("ko-KR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function CashFlowTable({ rows, custodyCurrency }: CashFlowTableProps) {
  const data = rows ?? [];
  const isKrw = custodyCurrency === "KRW";
  const hasSpecialTax = data.some((row) => row.specialTax !== null);

  const columns = [
    "이자계산일",
    "원금",
    "이자",
    "과세소득",
    "과세표준",
    "소득세",
    ...(hasSpecialTax ? ["농특세"] : []),
    "세후수령액",
  ];

  const total = data.reduce(
    (acc, row) => ({
      principal: acc.principal + row.principal,
      interest: acc.interest + row.interest,
      taxableIncome: acc.taxableIncome + row.taxableIncome,
      incomeTax: acc.incomeTax + row.incomeTax,
      specialTax: acc.specialTax + (row.specialTax ?? 0),
      netAmount: acc.netAmount + row.netAmount,
    }),
    {
      principal: 0,
      interest: 0,
      taxableIncome: 0,
      incomeTax: 0,
      specialTax: 0,
      netAmount: 0,
    }
  );

  const colWidth = `${(100 / columns.length).toFixed(4)}%`;
  const renderColgroup = () => (
    <colgroup>
      {columns.map((col) => (
        <col key={col} style={{ width: colWidth }} />
      ))}
    </colgroup>
  );

  const isTruncated = data.length > MAX_VISIBLE_ROWS;
  const headRows = isTruncated ? data.slice(0, HEAD_ROWS) : data;
  const tailRows = isTruncated ? data.slice(data.length - TAIL_ROWS) : [];
  const omittedCount = data.length - headRows.length - tailRows.length;

  const renderRow = (row: CashFlowRow) => (
    <tr
      key={row.date}
      className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
    >
      <td className="whitespace-nowrap py-2 pr-4 text-zinc-700 dark:text-zinc-300">
        {row.date}
      </td>
      <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
        {row.principal ? formatAmount(row.principal, isKrw) : ""}
      </td>
      <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
        {formatAmount(row.interest, isKrw)}
      </td>
      <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
        {formatAmount(row.taxableIncome, isKrw)}
      </td>
      <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
        {formatAmount(row.taxBase, isKrw)}
      </td>
      <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
        {formatAmount(row.incomeTax, isKrw)}
      </td>
      {hasSpecialTax && (
        <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
          {formatAmount(row.specialTax as number, isKrw)}
        </td>
      )}
      <td className="whitespace-nowrap py-2 text-right tabular-nums font-medium text-zinc-900 dark:text-zinc-100">
        {formatAmount(row.netAmount, isKrw)}
      </td>
    </tr>
  );

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950 sm:p-6 print:p-2">
      <h2 className="mb-5 print:mb-1 text-base font-semibold text-zinc-900 dark:text-zinc-100">
        현금흐름표
      </h2>

      {data.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          채권정보와 신탁계약일, 신탁투자금액, 선취/후취보수율을 모두
          입력하면 현금흐름표가 표시됩니다.
        </p>
      ) : (
        <>
          {/* 화면: 전체 행 표시 */}
          <div className="overflow-x-auto print:hidden">
            <table className="w-full min-w-[900px] table-fixed text-sm">
              {renderColgroup()}
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-100 text-left text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                  {columns.map((col, i) => (
                    <th
                      key={col}
                      className={`whitespace-nowrap py-2 pr-4 font-medium ${
                        i > 0 ? "text-right" : ""
                      }`}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>{data.map(renderRow)}</tbody>
              <tfoot>
                <tr className="border-t border-zinc-200 bg-orange-50 dark:border-zinc-800 dark:bg-orange-950/30">
                  <td className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                    합 계
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                    {formatAmount(total.principal, isKrw)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                    {formatAmount(total.interest, isKrw)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                    {formatAmount(total.taxableIncome, isKrw)}
                  </td>
                  <td className="py-2 pr-4" />
                  <td className="py-2 pr-4 text-right tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                    {formatAmount(total.incomeTax, isKrw)}
                  </td>
                  {hasSpecialTax && (
                    <td className="py-2 pr-4 text-right tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                      {formatAmount(total.specialTax, isKrw)}
                    </td>
                  )}
                  <td className="py-2 text-right tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                    {formatAmount(total.netAmount, isKrw)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* 인쇄: 앞/뒤 일부만 표시하고 중간은 생략 */}
          <div className="hidden overflow-x-auto print:block">
            <table className="w-full min-w-[900px] table-fixed text-sm">
              {renderColgroup()}
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-100 text-left text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                  {columns.map((col, i) => (
                    <th
                      key={col}
                      className={`whitespace-nowrap py-2 pr-4 font-medium ${
                        i > 0 ? "text-right" : ""
                      }`}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {headRows.map(renderRow)}
                {isTruncated && (
                  <tr className="border-b border-zinc-100 dark:border-zinc-900">
                    <td
                      colSpan={columns.length}
                      className="py-2 text-center text-xs text-zinc-400 dark:text-zinc-600"
                    >
                      ⋮ 중간 {omittedCount.toLocaleString("ko-KR")}건 생략 ⋮
                    </td>
                  </tr>
                )}
                {tailRows.map(renderRow)}
              </tbody>
              <tfoot>
                <tr className="border-t border-zinc-200 bg-orange-50 dark:border-zinc-800 dark:bg-orange-950/30">
                  <td className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                    합 계
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                    {formatAmount(total.principal, isKrw)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                    {formatAmount(total.interest, isKrw)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                    {formatAmount(total.taxableIncome, isKrw)}
                  </td>
                  <td className="py-2 pr-4" />
                  <td className="py-2 pr-4 text-right tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                    {formatAmount(total.incomeTax, isKrw)}
                  </td>
                  {hasSpecialTax && (
                    <td className="py-2 pr-4 text-right tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                      {formatAmount(total.specialTax, isKrw)}
                    </td>
                  )}
                  <td className="py-2 text-right tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                    {formatAmount(total.netAmount, isKrw)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      <p className="hidden print:block text-xs">&nbsp;</p>

      <div className="mt-6 print:mt-1 space-y-0.5 print:space-y-0 text-xs leading-relaxed print:leading-snug text-zinc-500 dark:text-zinc-400">
        <p>
          - 본 자료는 내부직원에 대한 정보제공만을 목적으로 한 것으로서,
          투자권유를 위한 광고물로 활용될 수 없고, 투자자에게 배포될 수
          없습니다.
        </p>
        <p>
          - 상기 현금흐름은 단순계산에 의한 수익률이므로 실제 투자와 차이가
          있을 수 있습니다.
        </p>
        <p>- 채권 이자는 만기일에 일시 지급합니다.</p>
        <p>
          - 과세소득 등은 원화(KRW)로 산정되므로, 실제 과세소득과 세금,
          세후수령액은 다를 수 있습니다.
        </p>
        <p>
          - 본 상품은 실적배당 상품으로 예금자보호법의 적용대상이 아닙니다.
        </p>
        <p>
          - 채권 시장수익률 변동에 따라 수익률이 변동될 수 있으며,
          투자판단의 최종 책임은 투자자에게 있습니다.
        </p>
        <p>
          - 본 채권은 금융기관이 보증하는 것이 아니며, 정부가 사채의 가치를
          보증 또는 승인한 것도 아니며, 발행사 사정에 의해 원금의 전부 또는
          상당부분을 손실할 수 있으며, 중도매매시 시장금리 등에 따라
          원금손실이 발생할 수 있습니다.
        </p>
        <p>
          - 특정금전신탁에 편입된 증권의 만기시 해당 증권 발행인의
          재무상황에 따라 원리금 상환이 지연될 수 있습니다. 이에 따라
          신탁계약의 해지가 지연될 수 있습니다.
        </p>
        <p>
          - 본 상품에 투자하시기 전에 투자대상, 환매방법, 보수 등과
          관련하여 반드시 신탁계약서 및 상품설명서 신용평가서 등의 내용을
          확인하시기 바랍니다.
        </p>
        <p>
          - 본 자료는 참고용일 뿐 정확성이나 완전성을 보장할 수 없습니다.
          따라서 어떠한 경우에도 고객의 투자 결과와 관련된 법적 책임 소재에
          대한 증빙으로 사용될 수 없습니다.
        </p>
      </div>
    </section>
  );
}
