-- CreateTable
CREATE TABLE "group_messages" (
    "id" SERIAL NOT NULL,
    "groupJid" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "senderName" TEXT,
    "text" TEXT NOT NULL,
    "replyToMessageId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_messages_groupJid_sentAt_idx" ON "group_messages"("groupJid", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "group_messages_groupJid_messageId_key" ON "group_messages"("groupJid", "messageId");
