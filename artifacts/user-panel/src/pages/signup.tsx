import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLocation, Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight, Loader2, ShieldCheck, KeyRound } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormMessage, FormLabel } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import buySellIconImg from "@/assets/buy-sell-icon.png";

// ── validation ──────────────────────────────────────────────────────────
const detailsSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name"),
  phone: z.string().trim().regex(/^\d{10}$/, "Enter a valid 10-digit mobile number"),
  apiKey: z.string().trim().min(1, "API key is required"),
  secretKey: z.string().trim().min(1, "Secret key is required"),
});

const otpSchema = z.object({
  otp: z.string().length(4, "Enter the 4-digit code"),
});

type DetailsForm = z.infer<typeof detailsSchema>;
type OtpForm = z.infer<typeof otpSchema>;

// ── error helper (same shape as login.tsx) ───────────────────────────────
function getErrorMessage(err: unknown, fallback: string): string {
  if (!err) return fallback;
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object") {
    const anyErr = err as Record<string, unknown>;
    if (typeof anyErr.error === "string") return anyErr.error;
    if (typeof anyErr.message === "string") return anyErr.message;
  }
  return fallback;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw data;
  return data as T;
}

interface SignupAccount {
  id: number;
  name: string;
  maskedMobileNumber: string;
  isActive: boolean;
}

export default function Signup() {
  const [step, setStep] = useState<"details" | "otp">("details");
  const [pendingDetails, setPendingDetails] = useState<DetailsForm | null>(null);
  const [, setLocation] = useLocation();
  const { account, setAccount } = useAuth();
  const { toast } = useToast();

  const detailsForm = useForm<DetailsForm>({
    resolver: zodResolver(detailsSchema),
    defaultValues: { name: "", phone: "", apiKey: "", secretKey: "" },
  });

  const otpForm = useForm<OtpForm>({
    resolver: zodResolver(otpSchema),
    defaultValues: { otp: "" },
  });

  const sendOtp = useMutation({
    mutationFn: (phone: string) => postJson<{ success: boolean }>("/api/auth/signup/send-otp", { phone }),
  });

  const verifyOtp = useMutation({
    mutationFn: (data: DetailsForm & { otp: string }) =>
      postJson<{ account: SignupAccount }>("/api/auth/signup/verify-otp", data),
  });

  const onDetailsSubmit = (data: DetailsForm) => {
    sendOtp.mutate(data.phone, {
      onSuccess: () => {
        setPendingDetails(data);
        setStep("otp");
        toast({ title: "OTP Sent", description: "Please check your messages." });
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "Failed to send OTP",
          description: getErrorMessage(err, "An error occurred"),
        });
      },
    });
  };

  const onOtpSubmit = (data: OtpForm) => {
    if (!pendingDetails) return;
    verifyOtp.mutate(
      { ...pendingDetails, otp: data.otp },
      {
        onSuccess: (res) => {
          setAccount(res.account);
          toast({ title: "Account created", description: `Welcome, ${res.account.name}!` });
          // Navigation happens in the effect below, same pattern as login.tsx —
          // avoids racing the route guard in AuthProvider.
        },
        onError: (err) => {
          otpForm.setError("otp", { message: getErrorMessage(err, "Invalid OTP") });
        },
      }
    );
  };

  useEffect(() => {
    if (account) {
      setLocation("/");
    }
  }, [account, setLocation]);

  const [countdown, setCountdown] = useState(0);
  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [countdown]);

  const handleResend = () => {
    if (countdown > 0 || !pendingDetails) return;
    sendOtp.mutate(pendingDetails.phone, {
      onSuccess: () => {
        setCountdown(30);
        toast({ title: "OTP Resent", description: "Please check your messages." });
      },
    });
  };

  return (
    <div className="min-h-dvh bg-background flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-sm space-y-6 my-6">
        <div className="flex flex-col items-center space-y-1 text-center">
          <img src={buySellIconImg} alt="WealthFunds2x" className="w-10 h-10 rounded-xl mb-2" />
          <h1 className="text-xl font-bold tracking-tight">My Trade Study</h1>
          <p className="text-muted-foreground text-sm">Create your trading account</p>
        </div>

        {/*
          Grid-stack trick: both steps occupy the same grid cell
          (col-start-1 row-start-1), so the grid container auto-sizes
          to whichever card is tallest. This replaces `absolute inset-0`,
          which took the "details" card out of flow and collapsed this
          wrapper's height to ~0 — that's what was pushing the footer
          text up next to the form instead of below it.
        */}
        <div className="grid">
          <div
            className={`col-start-1 row-start-1 transition-all duration-300 ${
              step === "details"
                ? "opacity-100 z-10 translate-x-0"
                : "opacity-0 z-0 -translate-x-full pointer-events-none"
            }`}
          >
            <Card>
              <CardHeader>
                <CardTitle>Sign Up</CardTitle>
                <CardDescription>Enter your details and CoinSwitch API credentials</CardDescription>
              </CardHeader>
              <CardContent>
                <Form {...detailsForm}>
                  <form onSubmit={detailsForm.handleSubmit(onDetailsSubmit)} className="space-y-4">
                    <FormField
                      control={detailsForm.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Full Name</FormLabel>
                          <FormControl>
                            <Input placeholder="Enter your name" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={detailsForm.control}
                      name="phone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Mobile Number</FormLabel>
                          <FormControl>
                            <Input placeholder="Enter 10-digit number" type="tel" {...field} maxLength={10} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={detailsForm.control}
                      name="apiKey"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>CoinSwitch API Key</FormLabel>
                          <FormControl>
                            <Input placeholder="Enter API key" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={detailsForm.control}
                      name="secretKey"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>CoinSwitch Secret Key</FormLabel>
                          <FormControl>
                            <Input placeholder="Enter secret key" type="password" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                      <KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      Your API keys are encrypted at rest. You can update them anytime from your Profile.
                    </p>
                    <Button type="submit" className="w-full" disabled={sendOtp.isPending}>
                      {sendOtp.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                      Continue <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </form>
                </Form>
              </CardContent>
              <CardFooter className="justify-center text-sm text-muted-foreground">
                Already have an account?{" "}
                <Link href="/login" className="ml-1 text-primary hover:underline">Sign in</Link>
              </CardFooter>
            </Card>
          </div>

          <div
            className={`col-start-1 row-start-1 transition-all duration-300 ${
              step === "otp"
                ? "opacity-100 z-10 translate-x-0"
                : "opacity-0 z-0 translate-x-full pointer-events-none"
            }`}
          >
            <Card>
              <CardHeader>
                <CardTitle>Verification</CardTitle>
                <CardDescription>
                  Enter the 4-digit code sent to +{pendingDetails?.phone}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Form {...otpForm}>
                  <form onSubmit={otpForm.handleSubmit(onOtpSubmit)} className="space-y-6">
                    <FormField
                      control={otpForm.control}
                      name="otp"
                      render={({ field }) => (
                        <FormItem className="flex flex-col items-center">
                          <FormControl>
                            <InputOTP maxLength={4} {...field}>
                              <InputOTPGroup>
                                <InputOTPSlot index={0} className="w-14 h-14 text-xl" />
                                <InputOTPSlot index={1} className="w-14 h-14 text-xl" />
                                <InputOTPSlot index={2} className="w-14 h-14 text-xl" />
                                <InputOTPSlot index={3} className="w-14 h-14 text-xl" />
                              </InputOTPGroup>
                            </InputOTP>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={verifyOtp.isPending || otpForm.watch("otp").length !== 4}
                    >
                      {verifyOtp.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                      Verify & Create Account
                    </Button>
                  </form>
                </Form>
              </CardContent>
              <CardFooter className="flex justify-between items-center text-sm text-muted-foreground bg-muted/30 py-4">
                <button type="button" onClick={() => setStep("details")} className="hover:text-foreground">
                  Edit details
                </button>
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={countdown > 0}
                  className={`hover:text-foreground ${countdown > 0 ? "opacity-50" : ""}`}
                >
                  {countdown > 0 ? `Resend in ${countdown}s` : "Resend code"}
                </button>
              </CardFooter>
            </Card>
          </div>
        </div>

        <div className="text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
          <ShieldCheck className="w-4 h-4" />
          Encrypted & Secure Connection
        </div>
      </div>
    </div>
  );
}