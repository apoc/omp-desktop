// Pending input is independent of the run's streaming flag: an ask can
// block a live turn while unrelated jobs continue in the same process.
(function () {
  function pending(messages) {
    const seen = new Set();
    return messages.filter((message) => {
      if (message.kind !== "ask" || message.answered || message.cancelled)
        return false;
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
  }

  function summary(requests, concurrentWork) {
    return {
      requests: requests.length,
      questions: requests.reduce(
        (count, request) =>
          count +
          (request.method === "ask" ? (request.questions?.length ?? 1) : 1),
        0,
      ),
      questionsOnly: requests.every((request) => request.method === "ask"),
      concurrentWork: requests.length > 0 && !!concurrentWork,
    };
  }

  function title(request) {
    const question = request.questions?.[0];
    return (
      question?.question ||
      request.title ||
      request.message ||
      "Input requested"
    );
  }

  window.OMP_PENDING_INPUT = { pending, summary, title };
})();
