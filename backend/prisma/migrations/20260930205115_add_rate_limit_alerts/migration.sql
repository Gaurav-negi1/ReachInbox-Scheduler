-- CreateTable
CREATE TABLE "RateLimitAlert" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "reason" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "limit" INTEGER NOT NULL,
    "queuedAhead" INTEGER NOT NULL,
    "slackSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateLimitAlert_userId_createdAt_idx" ON "RateLimitAlert"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "RateLimitAlert" ADD CONSTRAINT "RateLimitAlert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
