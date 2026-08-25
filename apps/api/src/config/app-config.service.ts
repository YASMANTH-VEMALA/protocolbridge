import { Injectable } from "@nestjs/common";
import { type AppConfig, parseConfig } from "@protocolbridge/config";

@Injectable()
export class AppConfigService {
  readonly value: AppConfig = parseConfig();
}
