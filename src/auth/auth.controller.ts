import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { AuthenticatedSession } from "./auth.types";
import { AuthService } from "./auth.service";
import { ChallengeResponseDto } from "./dto/challenge-response.dto";
import { CreateChallengeDto } from "./dto/create-challenge.dto";
import { LogoutResponseDto } from "./dto/logout-response.dto";
import { RotateResponseDto } from "./dto/rotate-response.dto";
import { SessionResponseDto } from "./dto/session-response.dto";
import { VerifyChallengeDto } from "./dto/verify-challenge.dto";
import { VerifyResponseDto } from "./dto/verify-response.dto";
import { SessionService } from "./session.service";
import { RenameSessionDto } from "./dto/rename-session.dto";
import { SessionInventoryItemDto } from "./dto/session-inventory.dto";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
  ) {}

  @ApiOperation({
    summary: "Request a wallet challenge",
    description:
      "Returns a message that the client must sign with the Stellar wallet identified by " +
      "`walletAddress`. The challenge expires in 5 minutes and can be used only once.",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Challenge created successfully.",
    type: ChallengeResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: "Request body failed validation.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "The wallet address is not a valid Stellar Ed25519 public key.",
    type: ApiErrorDto,
  })
  @Post("challenge")
  createChallenge(@Body() body: CreateChallengeDto) {
    return this.authService.createChallenge(body.walletAddress);
  }

  @ApiOperation({
    summary: "Verify a wallet signature and obtain a session token",
    description:
      "Verifies the Ed25519 signature over the challenge message and, if valid, returns a " +
      "Bearer token scoped to the authenticated wallet. The challenge is consumed and cannot " +
      "be replayed.",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Signature verified. Session token issued.",
    type: VerifyResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: "Request body failed validation.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "The wallet address is not a valid Stellar Ed25519 public key.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Challenge expired/used, or wallet signature is invalid.",
    type: ApiErrorDto,
  })
  @Post("verify")
  verifyChallenge(
    @Body() body: VerifyChallengeDto,
    @Headers() headers?: Record<string, string | string[] | undefined>,
  ) {
    return this.authService.verifyChallenge(body, headers);
  }

  @ApiOperation({
    summary: "Return the current session user",
    description: "Returns the full profile of the authenticated user from the database.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Current session details.",
    type: SessionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Get("session")
  getSession(@CurrentUser() session: AuthenticatedSession) {
    return this.authService.getSession(session.id);
  }

  @ApiOperation({ summary: "List the authenticated user's sessions" })
  @ApiBearerAuth()
  @ApiResponse({ status: HttpStatus.OK, type: SessionInventoryItemDto, isArray: true })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ApiErrorDto })
  @UseGuards(AuthGuard)
  @Get("sessions")
  async listSessions(@CurrentUser() session: AuthenticatedSession) {
    const sessions = await this.sessionService.listForUser(session.id);
    return sessions.map((item) => ({
      ...item,
      deviceLabel: item.deviceLabel ?? "Unknown device",
      current: item.id === session.sessionId,
    }));
  }

  @ApiOperation({ summary: "Rename one of the authenticated user's sessions" })
  @ApiBearerAuth()
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: "Session label updated." })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ApiErrorDto })
  @UseGuards(AuthGuard)
  @Patch("sessions/:sessionId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async renameSession(
    @CurrentUser() session: AuthenticatedSession,
    @Param("sessionId") sessionId: string,
    @Body() body: RenameSessionDto,
  ) {
    await this.sessionService.renameForUser(session.id, sessionId, body.label);
  }

  @ApiOperation({
    summary: "Log out and revoke the active session",
    description:
      "Revokes the authenticated session server-side so its bearer token cannot be reused.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Session revoked successfully.",
    type: LogoutResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, expired, or revoked.",
    type: ApiErrorDto,
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post("logout")
  async logout(@CurrentUser() session: AuthenticatedSession) {
    await this.authService.logout(session.sessionId);
    return { status: "ok" };
  }

  @ApiOperation({
    summary: "Rotate the active session",
    description:
      "Atomically revokes the current session and returns a fresh opaque bearer token.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Session rotated successfully.",
    type: RotateResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "The active session is unavailable, expired, or already revoked.",
    type: ApiErrorDto,
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post("rotate")
  async rotate(
    @CurrentUser() session: AuthenticatedSession,
    @Headers() headers?: Record<string, string | string[] | undefined>,
  ) {
    const { token, sessionId, expiresAt } = await this.sessionService.rotate(
      session.sessionId,
      session,
      undefined,
      headers,
    );

    return { token, tokenType: "Bearer", sessionId, expiresAt };
  }
}
