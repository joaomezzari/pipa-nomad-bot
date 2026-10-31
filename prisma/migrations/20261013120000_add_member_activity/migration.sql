-- CreateTable
CREATE TABLE "member_activity" (
    "id" SERIAL NOT NULL,
    "groupJid" TEXT NOT NULL,
    "userJid" TEXT NOT NULL,
    "name" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3),

    CONSTRAINT "member_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "member_activity_groupJid_userJid_key" ON "member_activity"("groupJid", "userJid");
