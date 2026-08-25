import { createRazorpayGateway, type RazorpayOrderGateway } from "@protocolbridge/razorpay";

import { AppConfigService } from "../config/app-config.service";

export const RAZORPAY_GATEWAY = Symbol("RAZORPAY_GATEWAY");

export const razorpayGatewayProvider = {
  provide: RAZORPAY_GATEWAY,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): RazorpayOrderGateway => createRazorpayGateway(config.value),
};
