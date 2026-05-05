# When a function argument is intended to the function,
# all of that argument's lines should be intended similarly
F <- function(testing) {
  MyFunc(blah
          |> foo
          |> bar,
         arg2,
         ~ arg3)
}

(start
  |> Func1(foo
            |> bar,
           baz)
  |> end)

# But use general indentation if the function argument starts on the next line
(start
  |> Func1(
    foo
      |> bar,
    baz
      + qux)
  |> end)
