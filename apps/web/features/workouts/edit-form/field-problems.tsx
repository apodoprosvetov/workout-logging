// The messages a field collected, rendered where that field is.
export function FieldProblems({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <>
      {messages.map((message) => (
        <p key={message} className="text-sm text-red-600 dark:text-red-400">
          {message}
        </p>
      ))}
    </>
  );
}
