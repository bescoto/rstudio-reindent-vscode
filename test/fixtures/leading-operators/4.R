## Leading operators should follow the indentation of their scope
## not match the related opening parentheses 
function() {
  AnotherFunc <- (df
    |> group_by(x)
    |> summarize(mean=mean(y)))

  if (TRUE) {
    for (a in 1:5) {
      (1
        + 2)
      Func4 <- (a
        |> bar()
        |> baz())
    }
  }
}