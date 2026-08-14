import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Public } from "./auth.js";

@ApiTags("health")
@Controller()
export class HealthController {
  @Public()
  @Get("healthz")
  @ApiOperation({ summary: "Readiness/liveness probe" })
  @ApiResponse({ status: 200 })
  health() { return { status: "ok" }; }
}
