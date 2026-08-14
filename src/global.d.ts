import type { routing } from "@/i18n/routing";
import type messages from "../messages/zh.json";

declare module "next-intl" {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: typeof messages;
  }
}
