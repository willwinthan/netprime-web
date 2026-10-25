import React, { useEffect, useRef, useState } from "react";
import { useLocation } from "../../site/router";
import { Dialog } from "../../site/shared";
import { LeadFormView } from "./LeadForm";
import {
  CONSENT_EVENT, MarketingConfig, PublicLeadForm, captureAttribution, getConsent, hasTracking, loadMarketingConfig,
  loadPixels, markPopup, pageMatches, popupAllowed, setConsent, trackPageView
} from "./runtime";

/**
 * Mounted once inside the public site layout: captures ?ref/UTM, shows the PDPA cookie banner when
 * tracking is configured, loads pixels after consent, sends page_view on every navigation, and
 * runs lead popups (delay / scroll % / exit intent, per-page targeting, frequency cap).
 */
export const MarketingRuntime: React.FC = () => {
  const location = useLocation();
  const [config, setConfig] = useState<MarketingConfig | null>(null);
  const [consent, setConsentState] = useState(getConsent());
  const [popup, setPopup] = useState<PublicLeadForm | null>(null);
  const shownThisPage = useRef(false);

  useEffect(() => {
    captureAttribution();
    loadMarketingConfig().then(setConfig);
    const onConsent = () => setConsentState(getConsent());
    window.addEventListener(CONSENT_EVENT, onConsent);
    return () => window.removeEventListener(CONSENT_EVENT, onConsent);
  }, []);

  // Capture referral/UTM parameters on in-app navigations too (links with ?ref=).
  useEffect(() => { captureAttribution(); }, [location.search]);

  // Pixels + page_view (after consent only).
  useEffect(() => {
    if (!config || consent !== "granted" || !loadPixels(config.tracking)) return;
    // Let the page set its title first.
    const timer = window.setTimeout(trackPageView, 50);
    return () => window.clearTimeout(timer);
  }, [config, consent, location.pathname]);

  const bannerVisible = !!config && hasTracking(config.tracking) && consent === null;

  // Popups: first eligible form for this page; one popup per page view.
  useEffect(() => {
    shownThisPage.current = false;
    setPopup(null);
    if (!config || bannerVisible || location.pathname.startsWith("/dashboard")) return;
    const form = config.popups.find(f => f.popup && pageMatches(f.popup.pages, location.pathname) && popupAllowed(f));
    if (!form?.popup) return;
    const show = () => {
      if (shownThisPage.current) return;
      shownThisPage.current = true;
      markPopup(form, "shown");
      setPopup(form);
    };
    const { trigger, delay_seconds, scroll_percent } = form.popup;
    if (trigger === "delay") {
      const timer = window.setTimeout(show, delay_seconds * 1000);
      return () => window.clearTimeout(timer);
    }
    if (trigger === "scroll") {
      const onScroll = () => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        if (max <= 0 || (window.scrollY / max) * 100 >= scroll_percent) show();
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      return () => window.removeEventListener("scroll", onScroll);
    }
    // Exit intent: the pointer leaves through the top of the window (desktop browsers).
    const onLeave = (event: MouseEvent) => { if (!event.relatedTarget && event.clientY <= 0) show(); };
    document.addEventListener("mouseout", onLeave);
    return () => document.removeEventListener("mouseout", onLeave);
  }, [config, bannerVisible, location.pathname]);

  return (
    <>
      {bannerVisible && (
        <div role="region" aria-label="การตั้งค่าคุกกี้"
          style={{ position: "fixed", left: 16, right: 16, bottom: 16, zIndex: 9500, maxWidth: 760, margin: "0 auto", background: "#182443", color: "#fff",
            borderRadius: 18, padding: "18px 20px", boxShadow: "0 20px 40px -12px rgba(0,0,0,0.35)", display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <p style={{ margin: 0, flex: "1 1 320px", fontSize: 14, lineHeight: 1.6 }}>
            เราใช้คุกกี้ที่จำเป็นเพื่อให้เว็บไซต์ทำงานได้ และขอความยินยอมจากคุณเพื่อใช้คุกกี้วิเคราะห์และการตลาด
            (เช่น Google Analytics, Meta, TikTok) เพื่อปรับปรุงเว็บไซต์และนำเสนอหลักสูตรที่ตรงความสนใจ ตาม พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562
            คุณถอนความยินยอมได้ทุกเมื่อ <a href="/privacy" style={{ color: "#ffd2b8" }}>นโยบายความเป็นส่วนตัว</a>
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" className="ps-btn ps-btn-ghost" onClick={() => setConsent("denied")}>ปฏิเสธ</button>
            <button type="button" className="ps-btn ps-btn-primary" onClick={() => setConsent("granted")}>ยอมรับทั้งหมด</button>
          </div>
        </div>
      )}
      {popup && (
        <Dialog label={popup.title} onClose={() => setPopup(null)} width={480}>
          <h2 style={{ margin: "0 44px 6px 0", fontSize: 22 }}>{popup.title}</h2>
          {popup.description && <p className="ps-muted" style={{ margin: "0 0 16px" }}>{popup.description}</p>}
          <LeadFormView form={popup} compact onDone={() => markPopup(popup, "done")} />
        </Dialog>
      )}
    </>
  );
};
