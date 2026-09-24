import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import {
  AuthenticatedRoute,
  PublicRoute,
} from "../common/decorators/authorization-policy.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { AuthenticatedUser } from "./auth.types";
import { AuthService } from "./auth.service";
import { CreateChallengeDto } from "./dto/create-challenge.dto";
import { VerifyChallengeDto } from "./dto/verify-challenge.dto";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("challenge")
  @PublicRoute()
  createChallenge(@Body() body: CreateChallengeDto) {
    return this.authService.createChallenge(body.walletAddress);
  }

  @Post("verify")
  @PublicRoute()
  verifyChallenge(@Body() body: VerifyChallengeDto) {
    return this.authService.verifyChallenge(body);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get("session")
  @AuthenticatedRoute({ ownership: "user" })
  getSession(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getSession(user.id);
  }

  @Post("logout")
  @PublicRoute()
  logout() {
    return { status: "ok" };
  }
}
