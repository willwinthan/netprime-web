import React, { useState } from "react";
import { BarChart3, FileSpreadsheet, Layers } from "lucide-react";
import { can, useApi } from "../../hooks/useApi";
import { ProductsManager } from "./ProductsManager";
import { QuotesManager } from "./QuotesManager";
import { SalesReports } from "./SalesReports";

/**
 * Commerce console (tab for commerce.manage holders): products (bundles / paths / memberships /
 * installment packages), organization quotes and sales reports. OrdersPage embeds the same panels.
 */
export const CommercePage: React.FC = () => {
  const api = useApi();
  const manage = can(api.user, "commerce.manage");
  const tabs = ([
    ["products", "แพ็กเกจและชุดคอร์ส", <Layers size={14} />, manage],
    ["quotes", "ใบเสนอราคาองค์กร", <FileSpreadsheet size={14} />, manage],
    ["reports", "รายงานยอดขาย", <BarChart3 size={14} />, manage || can(api.user, "payments.manage")]
  ] as const).filter(t => t[3]);
  const [tab, setTab] = useState<string>(tabs[0]?.[0] ?? "reports");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div>
        <h1 style={{ fontSize: "24px" }}>การขายและแพ็กเกจ</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>ชุดคอร์ส เส้นทางการเรียน สมาชิก ผ่อนชำระ ใบเสนอราคา และรายงานยอดขาย (ชำระด้วยการโอนเงินทั้งหมด)</p>
      </div>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        {tabs.map(([key, label, icon]) => (
          <button key={key} type="button" onClick={() => setTab(key)} className={tab === key ? "tech-button-primary" : "tech-button-outline"} style={{ padding: "6px 14px", fontSize: "13px" }}>{icon}{label}</button>
        ))}
      </div>
      {tab === "products" && <ProductsManager />}
      {tab === "quotes" && <QuotesManager />}
      {tab === "reports" && <SalesReports />}
    </div>
  );
};

export default CommercePage;
