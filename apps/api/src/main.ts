import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { loadWorkspaceEnvironment } from "@protocolbridge/config";

import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/all-exceptions.filter";
import { AppConfigService } from "./config/app-config.service";

async function bootstrap(): Promise<void> {
  loadWorkspaceEnvironment();
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(AppConfigService).value;

  app.enableShutdownHooks();
  app.setGlobalPrefix("v1");
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Agent-Api-Key"],
  });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("ProtocolBridge API")
      .setDescription("ProtocolBridge verified commerce orchestration API with the P1 golden judging flow")
      .setVersion("0.1.0")
      .addBearerAuth()
      .addApiKey({ type: "apiKey", in: "header", name: "X-Agent-Api-Key" }, "agent-api-key")
      .build(),
  );
  SwaggerModule.setup("docs", app, document);

  await app.listen(config.port);
  Logger.log(`ProtocolBridge API listening on http://localhost:${config.port}/v1`, "Bootstrap");
}

void bootstrap();
