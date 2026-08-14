import { Body, Controller, Delete, HttpCode, Inject, Post, ValidationPipe } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";

import { Permissions, type AuthUser } from "./auth.js";
import { CurrentUser } from "./user.decorator.js";
import { DeleteAccountDataDto, SyncRequestDto } from "./sync.dto.js";
import { SyncService } from "./sync.service.js";

@ApiTags("profile-sync")
@ApiBearerAuth()
@Permissions("rootline:profiles:sync")
@Controller("v1")
export class SyncController {
  constructor(@Inject(SyncService) private readonly syncService: SyncService) {}

  @Post("sync")
  @HttpCode(200)
  @ApiOperation({ summary: "Commit profile mutations and retrieve a revision delta" })
  @ApiResponse({ status: 200, description: "Profile mutation receipts and ordered delta" })
  sync(
    @CurrentUser() user: AuthUser,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, expectedType: SyncRequestDto })) dto: SyncRequestDto,
  ) {
    return this.syncService.sync(user.sub, dto);
  }

  @Delete("account-data")
  @HttpCode(200)
  @ApiOperation({ summary: "Delete hosted profile data and rotate the sync epoch" })
  @ApiResponse({ status: 200, description: "New epoch required by all devices" })
  deleteAccountData(
    @CurrentUser() user: AuthUser,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, expectedType: DeleteAccountDataDto })) dto: DeleteAccountDataDto,
  ) {
    return this.syncService.deleteAccountData(user.sub, dto);
  }
}
